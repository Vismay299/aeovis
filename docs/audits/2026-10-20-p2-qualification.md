# P2: R20–R21 acceptance status

> <!-- doc-status -->
> **Status: LIVE.** Current acceptance status and operational guidance; release remains unverified.

Date: 20 October 2026, Asia/Kolkata. Baseline: merged PR
[#8](https://github.com/Vismay299/aeovis/pull/8), `c5530c9`.
Status: engineering follow-up implemented; **release unverified**.

The 16 October backlog remains the 404-case acceptance specification. This file
records the R20–R21 delta; neither #8 nor this follow-up closes the full repair
inventory. P0 dispatch/attempt work in PR #9 is separate.

| Area | Implemented in #8 | This follow-up | Still required |
|---|---|---|---|
| R20.1–2 | Canonicals, aliases, robots/sitemap, private/preview headers | Discoverable methodology/use-case pages; distinct demo metadata; public footer destinations | Deployed preferred/alias/preview verification and authorized Search Console observations |
| R20.3 | Claim guard and explicit experimental consumer status | Public sampling/surface/failure/denominator/limit explanation and focused workflows without comparative promises | Human material-claim review against deployed capabilities (R20-11) |
| R20.4 | No completed study | Study protocol below; no invented results | Authorized real baseline, reviewed registration, change/window, observations, failures/uncertainty and signed review (R20-12) |
| R20.5 | HTTP checks in CI | Chromium desktop/mobile, rendered metadata, marketing sample isolation and keyboard navigation (R20-08/09/10/16) | Live cases R20-13/14/15 |
| R21.1/4 | 404-case inventory, guarded offline dispatcher, subprocess failures retained | External evidence intake bound to clean commit/fixture hash; hashed artifacts, signed manual review fields; full case totals and negative regressions | Real dedicated database/live/soak/manual evidence; CI green alone cannot establish release acceptance |
| R21.2/3/5 | Production metric/claim contracts already present | Runtime declarations, README corrections, execution/compatibility map, current surface addendum and reproducible runbook | Complete legacy import/runtime removal audit and human documentation review (R21-14) |
| R21.6 | Conservative aggregation | QA/canary/deployment/rollback procedure | Real new-schema/old-reader and in-flight rollback exercises (R21-09/12/13); QA publication/later observation browser workflow (R21-15/16); signed release decision (R21-18) |

## Evidence and acceptance boundaries

R20 has seven U/I cases and four public browser cases implemented. Its remaining
five cases require two human reviews and three live checks. R21 has eleven U/I
cases; three database, two tenant-workflow browser and two manual cases remain
unverified. The four public browser cases cannot replace those R21 scenarios.

Run commands in [the qualification runbook](../runbooks/p2-release-qualification.md).
Browser output is `test_reports/public-browser/evidence.json`, with per-case
assertion logs and screenshots; CI uploads `public-browser-<commit>` artifacts.
Offline/release reports live under `test_reports/repairs/<commit>/R20|R21/`.
Generated evidence is not checked into source or relabelled as evidence of a
later commit. Each final release packet must use one clean commit and fixture
manifest. Missing evidence keeps the affected suites blocked and release nonzero.

A reviewed packet is an attestation; artifact hashing detects changes, not false
claims. Human reviewers must inspect the evidence, production version and trusted
job provenance before approving release. No provider requests, production writes,
Search Console operations or human sign-off are implied by these source changes.

## Owned-site study protocol — proposed, not a result

Before observations, an authorized Perceev property owner and reviewer must
register the exact property, immutable question IDs/text and panel version,
offered surfaces, verified versus requested geography/language/device/session,
baseline dates, intended site changes and a real evaluation window. Commit the
registration and approval before changing the site or looking at outcomes.

Collect a baseline using the approved method and bounded request/spend ceilings.
Record every planned opportunity, valid no-AIO, answer, failure, non-attempt,
request ID, prompt/version, timestamp and raw evidence reference. Freeze the
metric/policy/parser/model versions and comparison/exclusion rules. Specify the
primary metric and interval method before collecting the post-change period.

Record actual deployment/change timestamps. Observe the same compatible panel
through the predeclared window, preserving outages and missing evidence. Report
raw numerators/denominators, distinct eligible question counts, coverage,
uncertainty and all exclusions. Describe associations without claiming causation
from a simple before/after comparison. Never replace missing real observations
with synthetic examples or a simulated-clock soak.

Publish results only after the owner and human reviewer inspect complete evidence
and sign R20-12. Until those identities, baseline and dates exist, this protocol
is unregistered and the owned-site proof deliverable remains open.
