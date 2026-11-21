# Design

> <!-- doc-status -->
> **Status: LIVE.** Visual authority, updated 21 October 2026 for the owner's decision to match OpenSEO's customer app (features/F04). Supersedes the 13 October "one light interface" rule for the customer app only.

## Two surfaces

The public website (marketing pages, free scan, dashboard, methodology) keeps one light interface with its own styles in `src/app/globals.css` and `src/components/design-system/primitives.css`. The customer app (`/portal`, sign-in, onboarding, `/ops`) uses the shadcn base-nova system ported from OpenSEO, with light, dark and system themes chosen per browser; `/ops` stays light.

## Tokens

Tokens live in `src/styles/app-theme.css`, imported by `src/app/globals.css`. Perceev uses primary `#3730CE` and destructive `#B02F2F`. Every text/background pair achieves WCAG contrast ≥ 4.5:1 in both light and dark themes. Chart rules: owned-brand series use `--chart-you`, rivals use `--chart-rival-*`, categorical series use `--chart-1…5`, and green, amber, red status colors are reserved only for real operational and collection status.

## Components

App UI primitives live in `src/components/ui`, and shared app composite components live in `src/components/app`. The `ui.jsx` facade adapts legacy portal callers to the shared primitives; do not create a third palette or independent control style.

## Information and interaction

Lead with the result and the evidence that explains it. Preserve the distinction
between measured zero, unavailable collection and insufficient samples. Simulations
are visibly labelled and never mixed into customer history.

Keep content generation, the agent builder and human review in one recognisable
workspace. Canvas diagrams can use nodes and connectors because they represent a
workflow, but must share the same light surfaces and controls. No active run means
no invented running state. Approval does not imply automatic publishing.

Use visible focus rings, semantic form labels, keyboard-accessible controls and
internal scroll areas for wide tables/canvases. At narrow widths, stack content and
keep the page itself within the viewport. Respect reduced motion.

## Locked UI decisions

The owner's keep / reject list from the UI lab review is in `docs/design/UI_LAB_DECISIONS.md` (locked 17 November 2026). It governs the frontend build.

## Motion

Timing tokens and motion utilities live in `src/styles/motion.css`. State changes are CSS transitions so they can be interrupted and reversed mid-way; keyframes are kept for loaders and one-shot entrances. Popups and dialogs animate from Base UI's `data-starting-style` / `data-ending-style`. A press scales a control to 0.97 in 110ms. Numbers roll digit by digit (`RollingNumber`), a busy button eases a spinner in and a finished one draws a tick, tabs share one sliding indicator, and a thin bar tracks route changes (`NavigationProgress`). A press also spreads an ink ripple from the pointer, a tick or radio fills from its centre and bursts a ring, the sidebar highlight is one pill that slides between rows (`SidebarActivePill`), and cards rise in as they scroll into view. Everything shortens or stops under `prefers-reduced-motion`.

## Colour scheme review (branch `test_UI`)

The base scheme is Onyx and White (`data-palette="onyx"`, set on `<html>` for every visitor): a dark, two-colour scheme that renders the same in every theme preference. `src/styles/palettes.css` also holds the variants under review, five further shades and six accents, and `src/styles/shapes.css` holds three component shapes (Soft is the base; Edge and Pill are under review). Variants switch with `data-palette` and `data-shape` on `<html>`. No attribute means the shipped palette above. The floating dock (`PaletteSwitcher`) and the `/ui-lab` page are review tools: they render in development, and in a build only with `NEXT_PUBLIC_PALETTE_REVIEW=1`. Once a scheme is chosen, move its values into `app-theme.css` and `globals.css` and delete the dock, the lab and `palettes.css`.

## Component libraries

Four shadcn registries are configured in `components.json` and their components are vendored as source, never imported from a package: Bklit UI for charts (`src/components/charts`, tokens in `src/styles/charts.css`), Motion Primitives (`src/components/motion-primitives`), Kokonut UI (`src/components/kokonutui`) and Watermelon UI (`src/components/watermelon`, Base UI variants only). anime.js drives the scan grid (`DotGridPulse`). Animation imports come from `motion/react`; `framer-motion` is no longer installed.

Adding more: `npx shadcn add @bklit/<name>` and so on. The CLI also tries to append its own colour variables and a `.dark` variant to `src/app/globals.css` and to create `src/lib/utils.ts`. Undo both: chart tokens live in `src/styles/charts.css` mapped to the scheme, and `cn` lives in `src/shared/utils.ts`. Pass `--path src/components/motion-primitives` for Motion Primitives, which otherwise lands in `src/components/ui`.

## Retired

Do not restore the split-screen auth showcase, the native workspace `<select>`, the `pv-*` layout classes, OS-driven dark mode on the public website, or a theme switch on public pages.

## Implementation

- Tokens, theme and utilities: `src/styles/app-theme.css`, `src/shared/theme/theme.ts`, `src/components/app/theme/SurfaceSync.tsx`, `src/components/app/theme/useThemePreference.ts`, `src/components/app/theme/ThemePreferenceRadio.tsx`.
- Primitives: `src/components/ui/*.tsx` (the 31 base-nova primitives), `src/shared/utils.ts`, `components.json`.
- Shared app components: `src/components/app/` — `PageHeader`, `PageFrame`, `EmptyState`, `ErrorState`, `QueryState`, `SkeletonPresets`, `CardShell`, `InlineConfirm`, `NavTabs`, `Markdown`, `StatusScreen`, `PermissionHint`, `AppBanner`, `NotFound`, `ErrorBoundaryCard`, `brand/PerceevLogo`, `shell/*`, `navigation/*`, `providers/AppProviders.tsx`, `hooks/use-mobile.ts`.
- Shell and workspace routes: `src/app/portal/layout.jsx`, `src/components/portal/PortalShell.jsx`, `src/app/portal/not-found.tsx`, `src/app/portal/error.tsx`, `src/app/portal/settings/layout.tsx`, `src/app/api/customer/features/route.ts`.
- Migrated workspace pages: `src/app/portal/page.jsx`, `src/app/portal/scans/page.jsx`, `src/app/portal/scans/[scanId]/page.jsx`, `src/app/portal/measurement/page.jsx`, `src/app/portal/content/page.jsx` with `src/components/portal/content/*`, `src/components/portal/gsc/*`, `src/components/portal/team/TeamPage.jsx`.
- Auth shell and routes: `src/components/portal/AuthLayout.jsx`, `src/app/login/layout.jsx`, `src/app/signup/layout.jsx`, `src/app/onboarding/layout.jsx`, `src/app/auth/layout.jsx`, `src/components/portal/onboarding/LegacyOnboardingForm.jsx`.
- Operator surfaces: `src/app/ops/layout.jsx`.
