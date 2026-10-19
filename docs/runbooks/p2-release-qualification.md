# R20–R21 acceptance and release qualification

Status: implemented engineering checks; full release acceptance remains open.
Reviewed against the #8 baseline (`c5530c9`) and this follow-up on 20 October 2026,
Asia/Kolkata. No production migration or deployment is performed by these checks.

## Reproduce engineering checks

Use a clean checkout with full Git history (the documentation tripwire reads it),
Node 22.22–22.x and both lockfiles. Do not load `.env.local` into acceptance jobs.

```sh
npm ci
npm --prefix worker ci
npm test
npm run fleet:check
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key npm run build
node node_modules/next/dist/bin/next start -p 3328
```

In a second terminal in the same checkout:

```sh
node scripts/qa/check-public-site.mjs http://127.0.0.1:3328
npx playwright install chromium
npm run qa:public-browser -- http://127.0.0.1:3328
npm run qa:repair -- --repair R20 --suite offline --output
npm run qa:repair -- --repair R21 --suite offline --output
```

The HTTP check exercises rendered canonicals, bare/nested private headers,
robots/sitemap and the path/query-preserving alias redirect. The browser job
records R20-08/09/10/16: six public routes, distinct metadata, desktop/mobile
layout, real keyboard navigation, and sample identity/cardinality/history and
request isolation. Only localhost is accepted; browser external requests and
mutations other than the local simulated scan are blocked and fail the check.
The server must be the disposable placeholder build above: browser routing alone
cannot prevent server-side requests if a real credentialed server is supplied.
No real scan is submitted.

CI's build job runs HTTP and browser checks and uploads the evidence even after
failure. A green engineering workflow establishes those checks only, not a full
release decision. Database, browser, live, soak and manual cases have separate
requirements in the 404-case backlog.

## Evidence packet contract

`--evidence packet.json` is accepted only for `--suite release` from a clean,
committed checkout. It imports results from dedicated jobs and human reviews;
it does not dispatch those jobs, authenticate a reviewer or certify that an
artifact's claims are true. Review artifacts and the CI job that produced them.
Use protected CI artifacts and an accountable human reviewer for release use.
The runner executes U/I afresh, so external evidence cannot replace offline tests.

A packet has `schemaVersion: 1`, full `commit`, `manifestHash` (SHA-256 of the
exact fixture manifest), `environment: "qa"`, `sourceClean: true`, and a nonempty `cases` array.
Each case contains:

- `case`: an existing acceptance ID; `suite`: its declared database/browser/live/manual/soak suite.
- `outcome`: `pass`, `fail`, `blocked` or `skipped`; `startedAt`/`endedAt`: real ISO timestamps.
- `expected`, `actual`, `command`: nonempty assertion/result and executed command or review procedure.
- `artifacts`: relative file paths and SHA-256 hashes, located inside the packet directory. Passing cases require at least one artifact.
- For manual passes, `review: { reviewer, rubric, decision: "approved" }` records the human sign-off.

The browser command writes this format. To combine independently produced
packets, retain their artifacts under the combined packet directory, adjust
relative paths and preserve hashes. All packets must refer to the same commit
and fixture manifest. Do not copy a prior build's pass into a new packet.
Duplicate IDs, wrong levels, stale commits, changed fixtures, invalid timestamps,
missing/tampered/escaping artifacts or unsigned manual passes are refused.
Unlisted cases remain blocked; imported failures/skips/blocks never become passes.

```sh
npm run qa:repair -- --repair R20 --suite release --environment qa \
  --evidence test_reports/public-browser/evidence.json --output
npm run qa:repair -- --repair R21 --suite release --environment qa \
  --evidence test_reports/public-browser/evidence.json --output
```

Exit 0 means all selected required suites passed; exit 1 means failed/unverified;
exit 2 means invalid input/environment/evidence; exit 3 means runner error.
Inspect JSON `cases`, `suites`, `skips` and the readable summary, not only the
exit code. Required manual cases are included in selected totals. Without
`--evidence`, the original conservative behavior remains: external suites cannot
pass. Reports default to `test_reports/repairs/<commit>/<repair>/`; save each run
as a separate CI artifact before repeating a command that uses that path.

## Runtime contracts and compatibility

The executing worker imports `scoring/enginePipeline.js` for enabled-engine
resolution/probing/summaries, `scoring/metricContract.js` for versioned DTOs and
`scanOutcome.js` for collection dispositions. `engines/deployedEngines.js` is the
build-time display list; `vendorRegistry.js` is configuration/readiness inventory.
Those lists have different responsibilities; registration or credential presence
alone does not qualify collection. `scoring/computeVisibilityScore.js` remains a
legacy tested module; its removal is deferred until historical readers, mutation
scripts and all consumers are mapped. This PR does not silently change old data.

Current metric DTO version is `r05-metric-v1`; eligibility is
`eligibility-policy-v1` (95% valid collection; 20 distinct eligible prompts in the
actual denominator). Raw `value_pct` and gated `qualified_pct` differ. Null with a
reason means unknown/ineligible; measured zero stays zero. Preserve observation,
panel, surface and policy versions when exporting or comparing reports.

Content drafting, review/decision, publication recording and later lift reporting
remain separate route families (`/api/content*`, `/api/content-items/*/decision`,
`publish`, `lift`). The tenant workflow uses `/api/customer/*` and membership/RLS
checks. R21-15/16 need actual QA identities and linked observations across these
boundaries; public browser checks cannot stand in for that acceptance.

The older [engine surface matrix](../contracts/engine-surface-matrix.md) contains
an explicitly dated historical baseline. Use its current-status addendum and
source symbols before making operational claims. See
[production migrations](../PROD_MIGRATIONS.md) for apply/verify procedures; this
follow-up adds no schema changes and does not assert migration deployment.

## Operator actions and deployment checks

On collection failure, retain failed/not-attempted counts and raw evidence.
Authentication/permission failures require operator configuration repair;
budget/key limits require a limits review; rate limits follow observed retry
information; timeouts/schema failures require provider/parser investigation.
Do not auto-fund, retry indefinitely or relabel errors as brand absence. Consult
`providerReadiness.js` and `providerFailure.js` for the typed classifications.

After an authorized deployment, make bounded read-only requests to the preferred
host, each actual alias and a known preview URL. Check statuses, canonicals,
private-route `X-Robots-Tag`, preview-wide noindex, robots and sitemap. R20-13
requires deployed pages matching this commit; R20-14 requires actual alias and
preview behavior. A localhost Host-header test is not deployed evidence.
R20-15 requires authorized Search Console observations with dates and property
identity. A submitted sitemap does not establish indexing. Record missing access
as blocked; never invent a preview URL or indexing success.

## Canary and rollback

Deploy the web changes to a QA/preview build first; run the browser/HTTP checks
against its matching local artifact and inspect the actual preview indexing
policy. Canary on an owned workspace only after dependent repair qualification.
Retain the prior deployment and immutable reports. This follow-up is additive
and has no database migration: reverting it restores #8's public routes and
runner. Remove the new public URLs from discovery if rolling back their routes.

Before broad release, R21-12/13 still require a real isolated database exercise
with new schema rows, old readers/workers, active leases and interrupted work.
Verify no duplicate work, dropped evidence or silently rewritten historical
metrics. A successful web revert is not evidence of those database scenarios.
R21-14/18 require human documentation/release review; keep affected claims blocked
until every required case, corpus and real elapsed soak is accounted for.
