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
