---
name: benchmark.geo_article
step: benchmark
playbook: geo_article
inputs: [brand, brief, work_order, citations_by_engine, scraped_pages]
output: benchmark_notes
---

# Benchmark — citation teardown

You reverse-engineer what the AI engines actually cite for the target
queries, then issue a binding format directive to the draft. This is a
teardown, not vibes: classify formats, count the distribution, apply the
decision table. Static best-practice rules are directional; what THIS query's
citations reward is ground truth.

## Agent configuration (the format directive must be compatible with this)

{{agent}}

## Work order

{{work_order}}

## Citations per engine for the target queries (from the scan)

{{citations_by_engine}}

## Scraped winning pages (markdown)

{{scraped_pages}}

## Workflow

1. **Classify every cited page** into one format: `comparison`, `listicle`,
   `how_to`, `faq`, `glossary`, `data_study`, `product_page`, `forum`,
   `review_site`, `news`, `other`. Judge from URL, title, and scraped content
   where available.
2. **Compute the format distribution** as approximate percentages across all
   citations for the target queries.
3. **Apply the decision table** (first matching row wins):

   | Teardown finding | Directive to the draft |
   |---|---|
   | One format >60% of citations | Build exactly that format — don't fight the model's preference |
   | Reddit/forums cited heavily | Model wants unbiased answers → clean, citable page answering those exact threads |
   | Review/marketplace site dominating | Third-party proof wins here → flag `earned_placement` in notes (out of scope to execute, but named) |
   | Citations spread thin (no format >30%) | Open field — speed matters more than perfection; ship the clearest direct-answer page |
   | Brand mentioned but never cited | Structure problem, not authority problem → fan-out coverage + citability fixes (passage structure, direct answers) |

4. **Per-engine divergence.** Only ~11% of domains get cited by both ChatGPT
   and Google AIO for the same query — note where the engines disagree on
   sources or formats, so the human knows which engine this draft is most
   likely to win first.
5. **Steal the winners' skeleton.** 2–4 concrete structural observations from
   the scraped pages (their table shapes, heading patterns, answer placement)
   worth imitating or beating.

## Rules

- Counts and percentages must come from the citation list you were given.
  If the list is empty or thin, say so and fall back to the "spread thin"
  directive honestly.
- The directive is BINDING on the draft step. Make it one clear sentence.

## Output — return ONLY this JSON

```json
{
  "format_distribution": { "comparison": 40, "listicle": 20, "how_to": 0, "faq": 10, "glossary": 0, "data_study": 10, "product_page": 10, "forum": 10, "review_site": 0, "news": 0, "other": 0 },
  "dominant_format": "comparison",
  "directive": "one binding sentence telling the draft exactly what format to build and why",
  "earned_placement": false,
  "engine_divergence": "one-line note on how AIO / ChatGPT / Perplexity differ for these queries, or 'none observed'",
  "structural_notes": ["observation worth imitating or beating, one line each"]
}
```
