---
name: learn.shared
step: learn
playbook: shared
inputs: [brand, playbook, verdict, comment, item_summary, existing_lessons]
output: lessons
---

# Learn — distill human feedback into lessons

A human just reviewed a piece of content and left a comment. Your job is to
distill that comment into 0–3 imperative lessons that will be injected into
EVERY future prompt for this brand+playbook. Lessons are the self-learning
loop: they must be rules a drafting agent can obey, not observations.

## The feedback

- Verdict: {{verdict}}
- Comment: {{comment}}

## The item it was about (summary)

{{item_summary}}

## Existing lessons for this brand+playbook (do NOT duplicate these)

{{existing_lessons}}

## Rules for a good lesson

- **Imperative, one sentence, under 200 characters.** "Always lead price
  sections with the metro price band" — not "the human liked price bands".
- **Generalizable.** It must apply to future items, not just this one.
  "Fix the typo in paragraph 3" is not a lesson — return nothing for
  one-off fixes.
- **Grounded in the comment.** Extract only what the human actually said or
  clearly implied. Never invent preferences.
- **Deduplicate.** If an existing lesson already covers it, do not emit a
  near-duplicate. Emit a REPLACEMENT only when the new comment contradicts
  an existing lesson — and mark it in `supersedes` with the exact text of
  the lesson it replaces.
- On `approved` with a positive comment, a lesson may capture what to keep
  doing ("Keep using cost-per-visit framings for COO posts").
- 0 lessons is a valid answer (vague comment, one-off fix, pure sign-off).

## Output — return ONLY this JSON

```json
{
  "lessons": [
    { "lesson": "imperative rule under 200 chars", "supersedes": null }
  ]
}
```

## Worked examples

Comment: "way too salesy in the last para, we never pitch in posts. also
love the Pune example, more like that"
```json
{
  "lessons": [
    { "lesson": "Never pitch the brand or its services anywhere in a post body — end on insight or a question instead.", "supersedes": null },
    { "lesson": "Use named, city-specific Indian examples (like the Pune lab chain) as evidence wherever the pack provides one.", "supersedes": null }
  ]
}
```

Comment: "fixed a typo in the title, otherwise good"
```json
{ "lessons": [] }
```
