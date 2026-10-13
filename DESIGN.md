# Design

> <!-- doc-status -->
> **Status: LIVE.** Visual authority, updated to the user's light-mode decision on 13 October 2026. Supersedes the former dark Signal Box direction. Implementation details: [shared design system](docs/design/DESIGN-SYSTEM.md).

## Product direction

Perceev has one light interface across its website, customer portal, scan flow,
reports, Content Studio, agent builder and demos. The OS appearance and old saved
theme preferences must not change the product. There is no theme toggle.

Use pale neutral page backgrounds, white cards, dark readable text and indigo
primary actions. Marketing can use larger display typography; it shares the same
font families, palette, controls, borders and surface treatments as the workspace.

## Shared system

- Palette, typography, spacing and semantic aliases: `src/app/globals.css`.
- Buttons, badges, cards and fields: `src/components/design-system/primitives.css`.
- Public product chrome: `src/components/design-system/PageFrame.jsx`.
- Workspace layouts and compositions: `src/components/portal/portal.css`.
- Existing `perceev` and `portal` component APIs adapt to the same primitives;
  do not create a third palette or independent control style.
- Root HTML and toast appearance are explicitly light before the first paint.

Default controls are 40px high; compact controls are 32px and large actions 48px.
Use 8px control corners and 12px card corners. Keep shared card padding and
sentence-case badges consistent. Use Archivo for normal text and Spline Sans Mono
for URLs, timestamps and evidence identifiers. Avoid tiny uppercase body labels.

The brand is lowercase `perceev`. Primary actions and owned-brand data are indigo.
Rivals use neutral colours. Green, amber and red are reserved for real status and
validation, not competitor rankings. Text must remain legible against its surface.

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

Do not restore OS-driven dark mode, saved-theme boot scripts, a theme switch,
navy page sections, the dark railway/steel palette, or the unused generated widget
library. Keep historical plans as records, not current visual instructions.
