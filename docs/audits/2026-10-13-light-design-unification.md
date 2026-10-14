# Light design unification — 13 October 2026

> <!-- doc-status -->
> **Status: LIVE.** Current UI implementation and validation evidence. Visual authority remains [DESIGN.md](../../DESIGN.md); live scan acceptance is incomplete.

The user selected one shared light design across the website, scans, reports,
Content Studio and demos. This replaces the former dark visual direction.

## Implementation

- The root HTML and toast renderer are explicitly light before first paint.
  Removed the saved-theme boot script, theme switch and OS/explicit dark palettes.
- `globals.css` owns one palette and semantic aliases. Shared primitive CSS owns
  controls, cards, badges and fields for the existing public/operator and portal
  component APIs. Default controls are 40px, compact controls 32px, with 8px control
  corners and 12px card corners.
- Website closing sections and footer inherit light tokens. The public demo uses
  the website navigation/footer and workspace headers, banners, cards and metrics.
- Studio fields and canvas configuration controls use shared field styling;
  removed duplicate textarea definitions and double padding in Studio cards.
  Generated IDs bind reusable field labels; raw builder fields have accessible names.
- Removed unused legacy customer portal/auth CSS, 46 unused generated UI modules,
  their orphaned toast hook/utility, and 30 unused top-level dependencies. A clean
  dependency install and production build confirm the remaining imports resolve.
- `DESIGN.md` is the current visual authority. Updated the supporting design
  reference, product direction and README so they no longer prescribe dark mode.

## Local validation

- Clean `npm ci --ignore-scripts`, production build and lint passed. Lint still has
  two existing hook warnings in dashboard `OpportunitiesPanel`.
- Full suite: 3,188 passed, zero failed, 30 skipped live tests (3,218 total).
- Root/theme and portal regression checks passed after final accessible-name cleanup.
- Browser review: homepage, free scan, sample report, operator Studio, login and
  public demo use light surfaces. Explicit dark OS emulation retained `data-theme`
  `light`, CSS `color-scheme: light`, and body background `rgb(247, 247, 250)`.
- Production demo completed 30 questions × 4 engines = 120 simulated answers.
  Created a comparison agent and added a Fact-Checker through the shared builder.
- Desktop 1280px and mobile 390px layouts were inspected; mobile document width
  remained 390px and the workflow canvas scrolls inside its card.
- Screenshot: `test_reports/2026-10-13/light-demo.jpg`.

## Limits and PR gate

These results validate the local UI and isolated simulation. They do not establish
healthy live provider collection or authenticated customer CRUD/generation/report
UAT. The blockers and required checks in
`2026-10-13-scan-and-studio-repair.md` still apply. No PR was created.
Pre-existing legal-page and legal-link edits were preserved outside this commit.

## Publication authorized by the user

- Pushed the tested commits to `main` and `codex/repair-scans-content-studio`.
- Production deployment `dpl_7r8ozERvHaw1esQWVqU4Ti8Mz8ch` reached Ready at
  `https://perceev.xyz` with application commit `0da312c`.
- Registered production `ENGINES` and `NEXT_PUBLIC_ENGINES` as
  `aio,chatgpt,gemini,perplexity` before the production build.
- Production variable registration and migration ledger passed `check:uat`.
- The live public demo completed 120 simulated answers. This is a simulation
  smoke test, not evidence of healthy live Google collection.
- GitHub CI build, fleet and customer database isolation passed. Its first unit
  test run found the missing status marker on this document; corrected here.

## Tenant correction after signed-in review

The user reported missing functionality after login. Signed-in review of the
trace workspace reproduced the empty agent roster and draft-first Studio.
The mock-scan entry navigated away to the public demo. The earlier public demo
and unauthenticated checks were insufficient acceptance evidence for tenants.

- Tenant Scans now embeds the same runnable simulation/report component as the
  public demo. Its authenticated endpoint derives brand facts from the authorized
  workspace and runs entirely in isolated memory, outside customer history.
- Studio opens on the workspace canvas and agent roster. Draft links and the
  New draft action still open the composer/editor directly.
- Read-only starter agents are present without privileged writes on GET. They
  can run with a validated template snapshot or be configured and explicitly
  saved as a customer agent. Saved agents remain scoped by workspace.
- Workspace changes reset the roster and ignore older responses; a simulation
  is aborted/reset when its tenant component is unmounted.
- Regression coverage renders the actual tenant pages, checks simulation
  isolation/authorization and validates both starter pipeline snapshots.
- Search Console was inspected while signed in; this account is not connected
  to Google. No new Google authorization was granted during this review.

## Authenticated tenant acceptance and deployment configuration

- Signed in to the trace workspace using the account supplied by the user.
  The production-environment staging build opens Studio on the canvas, exposes
  two runnable starter agents, and loads saved customer agents.
- Created and updated a six-specialist FAQ agent through the tenant builder.
  Its format, target length, custom instructions and added Fact-Checker persisted.
  The selected format now appears consistently in the composer, queue and library.
- Tenant mock scans completed 30 questions × four engines = 120 simulated
  answers inside Scans. They did not create scan history or use provider calls.
- A real draft initially failed its Writer deadline. Replaying the same prompt
  locally with low reasoning effort completed in 14 seconds. Bounded content
  reasoning and explicit format/length precedence are now used by the real
  markdown skills. Two isolated local pipeline runs reached human review.
- A fresh tenant draft reached `awaiting_approval`; the editor loaded its
  633-word FAQ, saved a title edit, and rendered linked sources in Preview.
  No approval or publication was performed. Generation review findings are now
  displayed in the tenant editor, including failed checks and sensitive claims;
  the checks explicitly describe the generated version, not later human edits.
- Real scan testing found production's utility model was `openrouter/free`
  and Bright Data rejected its token. Updated production's utility/content
  model settings and Bright Data credential from the working local configuration.
  The rebuilt staging scan passed prompt sourcing with a successful website
  scrape and Google seeding. Its later chunks resume on the existing live alias,
  so that run spans deployments and cannot establish clean live acceptance.
- Scan history now derives the engine labels from stored multi-engine summaries
  and flags partial collection. It does not return those summaries or raw answers
  in the listing DTO.
- Per-question collection failures are labelled separately from a genuine
  no-answer response. Only collected answers populate the missing-brand filter
  and content-gap action; questions without usable answers have their own filter.
- Production's old gateway key exhausted its $1 total limit during live UAT.
  Replaced it with the existing working local application key after checking
  that it had $1.70 remaining and was not a management key. No spending limit
  was raised and no credits were purchased. A new live acceptance is required
  after that credential rebuild; earlier denied answers remain unmeasured.
- Automated verification: 3,201 passed, zero failed, 30 skipped live tests;
  production build passed. CI separately verified tests, build, worker fleet
  and customer database isolation. Desktop and 390px tenant layouts were checked;
  the mobile document width remained 390px.

Localhost authenticated reads and simulation were tested, but real customer
CRUD/generation used production-environment staging because the local server
does not have an admin key. Live Google collection acceptance remains open;
the in-memory mock is not a substitute. No PR has been created.

## Final capture and scoring checks — 14 October

- Live scan `7faf2a1d-f550-4f16-ae3c-9b3f63c54f57` collected 30 of 30
  unbranded answers from each of ChatGPT, Gemini and Perplexity, with zero
  collection errors for those engines. Google collected 15 of 30 unbranded
  answers and recorded 16 collection errors overall, including its branded
  checks. Bright Data's enhanced AI Overview requests still report unavailable
  cookies. Two standard SERP probes did not contain genuine AI Overviews;
  neither was substituted for a successful capture.
- The capture exposed a scoring defect: the extraction prompt excluded software
  competitors, early Google answers exhausted the text budget, and discovery
  was capped before counting observed mentions. Extraction now permits direct
  software alternatives, shares evidence space across engines, preserves vendor
  headings, excludes failed captures, and caps discovered rivals after scoring.
- An isolated local rerank of the actual captured answers found scoring pools
  of 5 Google, 8 ChatGPT, 15 Gemini and 9 Perplexity answers, all above the
  minimum. The brand's visibility remained a measured zero. That extraction
  cost $0.00534075; it did not repeat provider queries or rewrite the customer's
  historical report. Three unverified Gemini citation lists remained excluded
  from the citation-share denominator.
- Reports now distinguish a limited scoring sample from failed collection.
  Healthy captures no longer say collection failed merely because few answers
  name a tracked brand. Partial collection retains its error count, and actual
  zero percentages survive the customer report DTO.
- Final local verification: 3,205 tests passed, zero failed, 30 live tests skipped;
  production build and lint passed, with two existing OpportunitiesPanel hook
  warnings. These checks do not establish fresh live collection under the final
  extraction changes.
- The user explicitly chose to retain the existing **$4 total gateway limit**.
  Its remaining allowance is below the approximately $1.58 consumed by the full
  four-engine acceptance scan. No limit increase or credit purchase was made,
  and another full paid scan was not started.

Overall live acceptance remains incomplete because Google collection has not
recovered and the final extraction changes have not had a fresh full live scan.
Historical reports remain snapshots of their original runs. The fixes can be
reviewed on the live tenant pages, but the user's PR gate remains unsatisfied;
no PR has been created.
