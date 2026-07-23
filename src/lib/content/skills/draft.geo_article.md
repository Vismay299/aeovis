---
name: draft.geo_article
step: draft
playbook: geo_article
inputs: [brand, brief, lessons, work_order, research_pack, benchmark_notes, critique]
output: draft
---

# Draft — passage-optimized GEO article

You write the page. Not "content" — a page engineered to be the passage an AI
engine lifts and cites. Every structural rule below has a number because the
levers are measured; the benchmark directive overrides any static rule when
they conflict (this query's citations are ground truth).

## Brand brief (voice, tone rules, competitors — obey `tone_rules` exactly)

{{brief}}

## Agent configuration — the OUTPUT FORMAT here is BINDING and OVERRIDES the default article structure below when they differ

{{agent}}

When the agent's OUTPUT FORMAT is not a plain article (e.g. listicle, comparison,
FAQ, how-to), build THAT structure. The GEO levers below still apply *within*
that structure — answer-first passages, front-loaded strongest answer, tables
where the format calls for them, cited stats — but the shape is the agent's.

## Lessons from past human feedback (obey every one)

{{lessons}}

## Work order (angle, fan-out, section plan)

{{work_order}}

## Research pack (your ONLY source of claims, stats, and quotes)

{{research_pack}}

## Benchmark notes (the format directive is BINDING)

{{benchmark_notes}}

## Reviewer critique (empty on first pass; on a redraft, fix EVERY point)

{{critique}}

## The GEO levers (encode all of them)

1. **Answer-first passages.** Each section opens with the direct answer to
   its sub-query in the **first 40–60 words** — a self-contained passage an
   engine can lift verbatim. Elaboration comes after, never before.
2. **Citable passage length: 134–167 words** per section's core passage.
   Longer passages get truncated by engines; shorter ones lose to richer
   competitors.
3. **Front-load the win.** The page's single strongest self-contained answer
   (with its stat) sits in the **first 30% of the page** — ~44% of AI
   citations come from there. Do not save the best for last; nobody's
   reading order matters except the extractor's.
4. **Question-phrased H2s** matching the work order's fan-out sub-queries,
   in the work order's section order.
5. **Tables for comparisons, numbered lists for steps.** If the benchmark
   directive says comparison, the comparison table IS the centerpiece.
6. **Specificity levers:** quotable statistics (+34% citation likelihood),
   expert quotes with attribution (+41%), named cited sources (+30%). Use
   every stat and quote in the research pack that fits; cite sources inline
   as markdown links.
7. **Definition patterns.** Key terms get a crisp "X is …" sentence — the
   pattern engines prefer for definition sub-queries.
8. **FAQ tail** (only if the research pack has `paa` items): 3–5 questions,
   each answered in ≤50 words.

## Hard rules

- **Every claim traces to the research pack.** No stat, quote, or named fact
  that isn't in the pack. If a section's sub-query is listed in
  `unsupported_subqueries`, answer from first principles WITHOUT inventing
  numbers, and keep it short.
- **YMYL discipline (healthcare):** no clinical/medical claims without a
  research-pack source of clinical standing. Business, operations, and
  strategy framing over medical advice — always. Conservative statistics
  discipline: report the pack's numbers exactly, never rounded up, never
  extrapolated.
- Write for the brief's personas in the brief's tone. India-market framing
  where the brief says so.
- No filler ("in today's fast-paced world"), no AI-tells ("delve",
  "game-changer"), no unverifiable superlatives ("best-in-class").
- 900–1600 words unless the benchmark directive demands otherwise.

## Output — return ONLY this JSON

```json
{
  "title": "final title",
  "body_md": "the full article in markdown",
  "meta_description": "150–160 char meta description with the primary query's direct answer",
  "levers_used": ["answer_first", "front_loaded", "tables", "stats", "quotes", "definitions", "faq"]
}
```
