# ADR — Bright Data is the SERP provider for Google AI Overview

> <!-- doc-status -->
> **Status: LIVE.** Supersedes
> [serp-provider.md](./serp-provider.md), which chose SerpAPI.

**Date:** 2026-08-29
**Supersedes:** [`docs/decisions/serp-provider.md`](./serp-provider.md) (SerpAPI vs DataForSEO)
**Status:** accepted, and already shipped — this ADR is being written *after* the
fact, which is the reason it exists.

---

## Context

The one ADR in this repository says SerpAPI won. Production has been on Bright
Data for some time. Nobody wrote the second decision down, so the only document
a new reader could find described a provider the code does not use, in enough
detail to be convincing. That is a worse failure than having no ADR at all: an
absent document invites you to go and read the code, and a confidently wrong one
does not.

This ADR records the decision that actually holds, and marks the old one
superseded rather than deleting it — the SerpAPI comparison is still the best
write-up of what the AI Overview probing problem requires.

## Decision

**Bright Data's SERP API is the provider for Google AI Overview probing.**

- Integration: [`src/lib/engines/brightdata.js`](../../src/lib/engines/brightdata.js)
- Credential: `BRIGHTDATA_API_KEY`
- Zone: resolved from `BRIGHTDATA_SERP_ZONE`, or discovered by picking the first
  `type: "serp"` zone with `status: "active"` from `GET /zone/get_all_zones`
- Request path: `POST https://api.brightdata.com/request`

## What is genuinely verified about this decision

Being precise about the evidence, because the document being superseded was
persuasive on numbers that no longer describe anything we run.

**Verified by reading the code at this commit:**

- Bright Data is the only SERP provider actually invoked for AIO probing.
- `SERPAPI_KEY` survives in exactly two places:
  [`src/lib/engines/types.js:43`](../../src/lib/engines/types.js), where it is
  accepted as an alternative "a SERP provider is configured" signal, and
  `src/lib/engines/serp.test.mjs`, which still sets it as a fixture. Neither
  makes a SerpAPI call. Both are dead weight and should be removed — see
  *Follow-ups*.

**NOT verified here, and deliberately not asserted:**

- Cost per query, coverage rate, and latency against SerpAPI. No live comparison
  was run for this document, and none is available in the repository. The
  superseded ADR's `$0.01/query` and `$0.15/scan` figures describe SerpAPI, not
  Bright Data, and must not be read across.
- Whether the zone-discovery fallback behaves correctly against a live account.
  `npm run check:secrets` is the script that answers this, and it has not yet
  been run against real credentials (rebuild task R0.1.6 is blocked on exactly
  that).

## Alternatives

| Option | Why not |
|---|---|
| **SerpAPI** | The prior choice. Superseded in practice before this ADR was written; the reasons were not recorded at the time and are not reconstructible from the repository. State that plainly rather than invent a rationale. |
| **DataForSEO** | Assessed in the superseded ADR and rejected there for task post-and-get complexity and weaker citation link maps. Nothing has changed that assessment. |

## What would reverse this

- A measured coverage rate for AI Overview blocks materially below what SerpAPI
  achieves on the same prompt set. That comparison needs the R0.4.1 baseline
  corpus to exist first.
- Bright Data zone management becoming an operational burden — in particular if
  the "no active serp zone" failure mode recurs. `check:secrets` reports that
  case explicitly, because a valid key with no active serp zone fails every
  scan while looking like a working credential.

## Follow-ups

1. Remove the `SERPAPI_KEY` branch from `src/lib/engines/types.js:43` and the
   fixture uses in `src/lib/engines/serp.test.mjs`. A dead credential path that
   still counts as "a SERP provider is configured" can make an unconfigured
   deployment look configured.
2. Record real Bright Data cost-per-scan once the R0.4.1 baseline corpus exists,
   and replace the "not verified" section above with measurements.
