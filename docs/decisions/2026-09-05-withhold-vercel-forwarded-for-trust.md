# ADR — `x-vercel-forwarded-for` is read, but not vouched for

> <!-- doc-status -->
> **Status: LIVE.** Supersedes nothing. Narrows one label set by R0.1.4 and
> kept by R0.1.18; it does not change which header the rate limiter reads.

**Date:** 2026-09-05
**Task:** R0.1.20 (`needs-vercel`), filed by the R0.1.18 implementer, who closed
the three trust-knob footguns and honestly declined to claim this one.
**Status:** accepted, shipped in the same commit as the code and the tests.
**Scope:** `src/lib/rateLimit.js` only. `src/app/api/scan/route.js` is
unchanged — it never read the `trusted` flag.

---

## Context

`resolveClientIp` picks the client address for the anonymous free-scan rate
limit. On a Vercel deployment it reads `x-vercel-forwarded-for` first and, until
now, labelled the result `trusted: true`.

That label rested entirely on one assumption: that Vercel's edge **overwrites**
an inbound header of that name rather than passing it through. The assumption is
Vercel's documented behaviour, and it may well be correct. It has never been
tested against this deployment.

Nothing inside a request handler can test it. A request carrying
`x-vercel-forwarded-for: 192.0.2.7` looks byte-identical whether the edge wrote
it or an anonymous caller typed it. No unit test can settle the question, which
is why R0.1.18 recorded it as an assumption instead of writing a check that
proves nothing.

If the assumption is ever false — a documentation error, an edge configuration
change, a route that bypasses the edge — the consequence is the worst available
combination:

1. An anonymous caller forges the header and lands in a rate-limit bucket of
   their choosing, so the per-IP limit is bypassable by rotating it.
2. The envelope asserts `trusted: true` about that identity.
3. **It is silent.** The warn-once fired only for UNTRUSTED sources, so the one
   log line that would have told an operator "this address is only a claim"
   was suppressed by the very label that was wrong.

A spoofable identity carrying a confidence label and no warning is worse than
the same identity carrying no label at all. That is standing rule 1 — a code
path that can silently do nothing must say so — applied to a trust claim.

## Decision

**Withdraw the `trusted: true` label from `x-vercel-forwarded-for`. Change
nothing else about how the address is chosen.**

Concretely, in `src/lib/rateLimit.js`:

- `TRUSTED_IP_HEADER` is renamed **`PLATFORM_IP_HEADER`**. It names the header
  the platform is *supposed* to control; it no longer promises trust the module
  cannot extend. The constant was imported only by this module and its own test.
- The Vercel branch of `resolveClientIp` returns `trusted: false` with
  `trustBasis: "platform-unproven"`.
- A new `trustBasis` field is carried on the identity and in **all three**
  envelope shapes `checkScanRateLimit` returns (normal, counter-threw,
  counter-returned-nonsense), because `trusted: false` alone cannot tell an
  operator whether the address came from the platform header nobody has proved
  or from a header the caller types. Those are different incidents.
- `TRUST_RESTORE_CHECK` is an exported constant naming exactly what would earn
  the label back, and it is interpolated into the operator-facing log line. Grep
  **`RESTORE-TRUST-R0.1.20`** to find every part of the deferral.

### What is deliberately NOT changed

**The header is still read first on Vercel, and the bucket key is
byte-identical.** Ordering and labelling are separate decisions: the ordering
picks the address least under the caller's control, the label says whether
anyone has proved that. Demoting the header to a lower rank would hand the
bucket to `x-real-ip` — a header the caller *definitely* writes — and would turn
a limit that might be bypassable into one that certainly is. An
untrusted-but-limited request is the goal; an unlimited one would be a worse bug
than the one this closes. `rateLimit.test.mjs` pins the resulting bucket key to
a literal so a future "withdrawal by demotion" cannot pass quietly.

**`SCAN_RATE_LIMIT_IP_HEADER` keeps `trusted: true`.** That is an out-of-band
human assertion by the operator about their own proxy, not an assumption this
module invented about someone else's edge. R0.1.18 already narrowed which names
it will accept.

**`POST /api/scan` is untouched.** It never read `rate.trusted`; the flag exists
for the log and the envelope. Nothing about the 429 changes.

## Consequence: one warning line per cold start on Vercel

The platform source is now untrusted, so it trips the untrusted-source
warn-once. On a Vercel deployment that means **one line per process** —
per basis, not per request:

```
[rate-limit] client address taken from x-vercel-forwarded-for on a Vercel
deployment. The limit IS applied to that address and the bucket is unchanged,
but this build does NOT vouch for it: ... Reported trusted:false until
RESTORE-TRUST-R0.1.20: a deploy-time check that forges x-vercel-forwarded-for
against the deployed origin and asserts the rate-limit bucket does not move ...
```

This is a deliberate cost, and it is bounded. The warn-once latch was widened
from one boolean to **one latch per trust basis** rather than being duplicated:
with a single boolean, a Vercel process would spend its one warning on the
platform line and then go silent if a later request in the same process fell all
the way back to `x-real-ip` — a strictly worse state hidden by the warning for a
better one. Three bases can warn, so at most three lines per process, and then
quiet. `resetUntrustedSourceWarning()` clears them all; the separate R0.1.18
latch for a misconfigured trust knob is untouched.

The message is basis-specific on purpose. The old text ended with "or deploy
behind Vercel where `x-vercel-forwarded-for` is trusted", which this decision
makes false; that clause is gone.

## What would restore the label

Exactly one thing, and it is the first branch of R0.1.20's acceptance criterion:

> a deploy-time smoke check that forges `x-vercel-forwarded-for` against the
> **deployed** origin and asserts the rate-limit bucket does not move, running
> somewhere an operator sees the result.

Two requests to the deployed `POST /api/scan` from one real client, carrying two
different forged values of that header, must consume two slots from the *same*
bucket. If the second one gets a fresh budget, the edge is passing the header
through and this module must stop reading it at all.

That check cannot be written honestly from inside this repo's test suite: it
needs a real deployment and a real request, and R0.1.20 says explicitly that
writing the script without running it is a partial result. So the label is
withheld instead. When the check exists and passes, the restorer changes
`resolveClientIp`'s Vercel branch back to `trusted: true`, deletes
`TRUST_BASIS.PLATFORM_UNPROVEN`, and cites the check run — not this document —
as the evidence.

## Alternatives rejected

**Leave the label and rely on the comment.** The comment at
`rateLimit.js:79` already said "NOT VERIFIED HERE" and the envelope still said
`trusted: true`. A machine-readable claim beats a human-readable caveat every
time; whoever consumes the envelope next would consume the claim.

**Stop reading the header on Vercel.** Strictly weakens the limit — see above.

**Write the smoke check and mark it "not yet run".** Explicitly blocked by the
task, and rightly: a script nobody has executed is evidence of intent, not of
behaviour.

**Warn per request instead of per process.** A log nobody reads is the same as
no log. Per-basis warn-once is the pattern this module already uses.
