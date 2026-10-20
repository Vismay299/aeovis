# Idea: locked core questions + AI-regenerated questions per scan

> <!-- doc-status -->
> **Status: LIVE.** Product idea captured 20 October 2026 at the owner's request. **Not approved, not scheduled, nothing built.** Do not implement from this note until the owner confirms the direction.

## Problem it answers

Today (after R14) a scan only runs against a hand-written, approved question panel (`src/app/api/customer/scan/route.js` refuses with 409 without one). The customer lands on a blank textarea. The product promise is the opposite: **the AI works out what buyers ask.** The question generator still exists (`generatePromptsForBrand` in `src/lib/prompts.js`: Firecrawl scrape, then Gemini summary, then 18–22 buyer questions) but nothing in the R14 panel flow calls it.

The opposite extreme — fresh AI questions every scan, as before R14 — makes scan-to-scan trends meaningless, because each scan measures a different question set.

## The idea

1. **First scan: all AI-generated.** No setup. The AI generates the full set (about 30 questions) from the website and category, and the scan runs on it.
2. **The customer locks the questions that matter.** After seeing results, they pick questions to keep, for example 5. Locked questions are asked on **every** later scan, unchanged.
3. **Everything else regenerates.** On each later scan the AI generates fresh questions for the remaining slots (for example 25), so coverage keeps exploring new buyer phrasing and topics.
4. The customer can lock or unlock at any time; a change applies from the next scan.

Rough shape: `scan set = locked core (stable) + rolling generated set (fresh each scan)`.

## What it means for metrics

- **Trends and deltas use only the locked core**, because only those are like-for-like across scans. This fits the existing R05 rule: refuse deltas across context or cohort boundaries.
- **The rolling set feeds discovery,** not trends: which brands appear, new topics, and questions the brand is losing. It reports per-scan only.
- Changing the locked set is a cohort boundary. Trends restart or are segmented from that point, just as panel-version boundaries are today (R14.5b).
- The headline visibility number must say which set it is computed on (locked core vs all questions in this scan).

## Open questions for the owner

- Core size: fixed (5?), a maximum, or free choice? Is there a minimum before trends are shown?
- Before anything is locked, is there any trend at all, or only per-scan results?
- Can the AI suggest which questions to lock (high intent, competitor present, brand absent)?
- Do branded diagnostic questions stay separate from both sets (as now: diagnostics, never in the headline)?
- Regeneration inputs: website only, or also earlier scan results and GSC queries, to avoid repeats?
- Cost: generation adds a scrape and two LLM calls per scan, on top of probing.

## Relation to existing work

- **Replaces** the "review and approve the whole panel before any scan" flow from R14 as the customer default. R14's storage (versioned and frozen snapshots, provenance `origin`, change log) is probably reusable: the locked core becomes the frozen versioned part, and each scan snapshots its full question set.
- Covers R14.2a (generation), which was never built; R14.2b (duplicate and self-brand checks) still applies to generated questions.
- Touches R05 (denominators and qualified metrics), R11 (scheduled scans), R19 (reporting cohorts).
