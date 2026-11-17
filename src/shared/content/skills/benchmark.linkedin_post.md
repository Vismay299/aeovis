---
name: benchmark.linkedin_post
step: benchmark
playbook: linkedin_post
inputs: [brand, brief, work_order]
output: benchmark_notes
static: true
---

# Benchmark — LinkedIn channel pack (static, v1)

Honest v1 note: there is no live LinkedIn data without an API integration.
This pack encodes current LinkedIn best practice for executive-voice posts;
the lessons loop (human feedback → stored lessons → injected into every
step) is the personalization mechanism that corrects it over time.

This step is STATIC — the runtime returns the pack below without an LLM
call. Edit this file to tune the channel rules.

## Channel pack (returned verbatim as `benchmark_notes.pack`)

```json
{
  "hook_patterns": [
    "Number-first: open with the stat, no preamble ('18% of every home-collection order goes to logistics.')",
    "Contrarian inversion: state the accepted belief, then flip it in sentence two",
    "Cost-of-inaction: name what the reader loses per week/quarter by not acting",
    "Specific story cold-open: drop into a concrete scene ('A 40-lab chain in Pune found out on a Tuesday.')",
    "Direct question to the persona: one sharp question they actually argue about internally"
  ],
  "formatting": [
    "First line must work standalone — it is all that shows before 'see more'",
    "1–2 sentence paragraphs; generous whitespace; no walls of text",
    "150–300 words total; senior voices do not need 800",
    "No hashtag soup: 0–3 hashtags, at the end, if any",
    "No links in the body (kills reach); 'link in comments' if needed",
    "Plain text beats formatting tricks; one emoji maximum, zero is fine"
  ],
  "structure": "Hook (1–2 lines) → evidence (the number/example) → implication for the persona → one crisp takeaway or question. No throat-clearing, no 'In today's fast-paced world'.",
  "cta_discipline": "One post = one idea = at most one soft CTA (a question or 'agree?'). Never pitch the brand's product in the post body — authority is the product.",
  "banned": [
    "Generic openers: 'In today's world', 'Now more than ever', 'I'm excited to share'",
    "Broetry ladders of one-word lines",
    "Engagement bait: 'Comment YES if…', tag-storms, polls-for-reach",
    "AI-tell phrases: 'delve', 'game-changer', 'It's not X, it's Y' repeated, 'Let that sink in'"
  ]
}
```
