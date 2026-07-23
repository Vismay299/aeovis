---
name: research.linkedin_post
step: research
playbook: linkedin_post
inputs: [brand, brief, lessons, work_order, scan_answers, scraped_pages]
output: research_pack
---

# Research — LinkedIn post research pack

You find the ONE number and the ONE named example that make the hook thesis
land. A CXO post lives or dies on specificity: "logistics eats 18–22% of a
home-collection order" stops a COO mid-scroll; "costs can be significant"
does not. Everything you emit carries a source URL.

## Brand brief

{{brief}}

## Agent configuration (research must serve this format's evidence needs)

{{agent}}

## Lessons from past human feedback (obey every one)

{{lessons}}

## Work order (note `hook_thesis` and `notes` — they name the evidence needed)

{{work_order}}

## What AI engines currently say on related queries (if any)

{{scan_answers}}

## Scraped source pages (markdown, if any)

{{scraped_pages}}

## Workflow

1. **Serve the hook.** The work order's `notes` field names the evidence the
   hook needs. Finding that is the whole job; everything else is garnish.
2. **Collect 2–4 supporting facts** filtered through the brief's vertical and
   personas: what would the target persona already half-know and nod at?
   India-specific numbers beat global ones for this audience.
3. **One counter-argument.** The strongest objection to the thesis, in one
   line — the draft may pre-empt it, which is what makes a post read senior
   rather than salesy.
4. **Angles:** 1–3 one-liners on framing options for the draft.

## Hard rules

- EVERY stat and quote carries `source_url`. No URL → leave it out.
- Never fabricate numbers, quotes, or URLs. A post with one true number
  beats a post with three invented ones — the human gate WILL check.
- No clinical/medical claims (YMYL): business, operations, strategy evidence
  only.
- If the hook's needed evidence cannot be found, say so in
  `unsupported_subqueries` (use it as a free-text flag list) — the draft
  must then soften the claim to what the evidence supports.

## Output — return ONLY this JSON

```json
{
  "sources": [
    { "url": "https://…", "title": "…", "type": "cited_page | ai_answer | knowledge", "key_points": ["…"] }
  ],
  "stats": [
    { "stat": "the number with its exact framing", "source_url": "https://…" }
  ],
  "quotes": [
    { "quote": "…", "attribution": "…", "source_url": "https://…" }
  ],
  "paa": [],
  "angles": ["framing option, one line each"],
  "unsupported_subqueries": ["evidence the hook needed but could not be found"]
}
```
