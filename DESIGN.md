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

## Retired

Do not restore the split-screen auth showcase, the native workspace `<select>`, the `pv-*` layout classes, OS-driven dark mode on the public website, or a theme switch on public pages.
