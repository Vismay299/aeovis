# Shared light design system

> <!-- doc-status -->
> **Status: SUPERSEDED-BY** [DESIGN.md](../../DESIGN.md) as visual authority. This subordinate implementation reference follows the user's light-only direction of 13 October 2026. Replaces the former three-state theme specification.

## Theme and tokens

The root layout renders `<html data-theme="light">`; toasts are also light.
There is no OS media-query palette, dark selector, saved-preference boot script or
theme toggle. All rendered surfaces inherit the same tokens from `globals.css`.

| Role | Token | Value |
| --- | --- | --- |
| Page | `--paper` | `#F7F7FA` |
| Surface | `--surface` | `#FFFFFF` |
| Inset | `--sunken` | `#EFEFF4` |
| Main text | `--ink-1` | `#0E1017` |
| Body | `--ink-2` | `#474C5A` |
| Secondary | `--ink-3` | `#565C6D` |
| Muted | `--ink-4` | `#64697B` |
| Border | `--line` | `#E2E3EB` |
| Strong border | `--line-strong` | `#CFD2DE` |
| Brand | `--brand` | `#3730CE` |
| Brand tint | `--brand-tint` | `#EEEEFC` |

Archivo is the shared UI/display family. Spline Sans Mono is for identifiers and
technical evidence. Use tabular figures for comparable numeric columns. Preserve
readable contrast and semantic good/warn/critical hues.

## Components

`src/components/design-system/primitives.css` defines the shared appearance of
buttons, cards, badges and fields. Existing `.btn`/`.pv-btn`, `.panel`/`.pv-card`,
`.chip`/`.pv-badge`, and `.inp`/`.pv-input` selectors are compatibility adapters to
those same definitions, not separate design systems.

Controls: 40px default, 32px compact, 48px large; 8px corners. Cards: white surfaces,
thin neutral borders, 12px corners, restrained neutral shadow, 20px horizontal
padding. Badges: 24px, sentence case. Fields share their borders, focus rings,
font, spacing and disabled states. Do not reintroduce inline copies of these
styles in the agent builder or demos.

`portal/ui.jsx` owns workspace compositions such as headers, KPI tiles and banners.
Public product pages use `design-system/PageFrame.jsx` for website chrome and those
same workspace primitives. The authenticated portal retains its workspace sidebar.
Marketing display text can be larger without changing the system.

## Evidence and workflows

Measured zero is a number; unavailable data is an em dash with its collection
state. Use owned-brand indigo and a neutral rival ramp. Do not manufacture live
telemetry, prompt volume, traffic, rankings or attribution. Demo scans stay
explicitly simulated and isolated from real history.

The agent canvas and crew editor remain functional, light workflow diagrams.
Research, writing, review and human approval are distinct steps. Maintain keyboard
focus visibility and internal scrolling of wide diagrams; avoid page overflow.

## Verification

Check homepage, free scan, sample report, sign-in and demo at desktop and mobile
widths. A dark OS setting must leave the light palette unchanged. Run the build,
lint and regression suite, including the light-design contract. The earlier
Results Night/Signal Box plans are historical and do not govern new UI work.
