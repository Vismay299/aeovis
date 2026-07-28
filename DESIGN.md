# Design

<!-- impeccable:design-schema 1 -->

## Visual World

**The Signal Box** — the illuminated interlocking diagram of a railway signal cabin,
adapted to answer-engine intelligence. The interface is the panel: a schematic of the
controlled area drawn in hairline silver on unlit painted steel, with lamps firing
behind it to show what is actually happening on the ground.

The mechanism maps exactly. Every buyer question is a **route request**. The engine
either **clears a path** to your brand or clears it to a rival. **Interlocking** is
the argument: routes are mutually exclusive, so two brands cannot hold the same path
in the same answer. Share-of-AI is the count of routes set to your platform. A rival
who won the citation is **occupying the section** you wanted. Probes arrive as berths
on a train describer; the verdict is the aspect the signal is showing.

This world is dark because the artifact is: a diagram panel is unlit until lamps fire
behind it. Dark mode is user-pinned and the world requires it.

The register is a working control panel read by one operator at a glance — engraved,
orthogonal, unhurried, legible under any light. Never a toy railway, never nostalgia,
never a terminal.

## Palette

USER-PINNED (binding): the palette is **neutral**. No signal-bright hue appears
anywhere. The interface is a graphite instrument; colour exists only to tell data
roles apart, and every tinted role is desaturated earth.

Panel steel — neutral graphite, no hue cast:

- `--panel-0` #0B0B0C page · `--panel-1` #121214 panel face · `--panel-2` #17181A
  raised/hover · `--panel-3` #1E1F22 active/pressed
- Engraved rules #212225 / panel edges #2E3034 / nickel bevel #414449
- Track line work: #5C5F66 in scope, #3A3D42 out of scope
- Lettering #EDEDEF / #A0A2A8 / #74767D · engraved plate text #8A8D94

**The lit state is light, not colour.** `--action` #EDEBE6 (bone) is the single
interactive fill: primary buttons, the set route, focus, selection. Nothing else is
filled.

Indication roles — desaturated earth, never a signal-bright hue:

- **YOUR ROUTE** bone #EDEBE6 — you, wherever you appear in data. Carried by weight
  and luminance as much as tone: your route is a 3px lit stroke against a 1px hairline.
- **CLEAR / PROCEED** sage #8CA394 — good standing, a cleared approach.
- **CAUTION** brass #B0925C — partial visibility, degraded, warnings.
- **OCCUPIED** oxide #A9604F — a rival holds the section. Danger, destructive actions.
- **ANNOTATION** slate #74849A — block-instrument marks only: neutral informational
  markers, never a data series and never a state.

Text-safe variants (`--lamp-*-text`) exist for every role and are the ones used on
type; the base values are for fills and strokes.

Magnitude is not a role. When a chart encodes quantity (heatmap cells, graded fills,
intensity), only your own series may ramp toward bone. Rival magnitudes ramp on the
neutral steel scale `--steel-1..5`. Oxide marks the occupied *role*, never "a lot of
something".

## Typography

One variable face, three voices, cut from `Archivo` (wdth 62–125, wght 100–900):

- **Signage** — wdth 118, wght 800, uppercase, tracking 0.01em. Display and headlines.
  This is the destination-board voice and it carries the brand.
- **Body** — wdth 100, wght 400/450, sentence case, 15px/1.6.
- **Engraved plate** — wdth 78, wght 700, uppercase, tracking 0.14em, 10–11px, in
  nickel. Labels a control, a panel, or a berth. Never introduces a prose section.
- Tallies and scores use wght 700 with tabular figures.
- Describer digits are drawn, not set: an SVG 14-segment component.
- `Spline Sans Mono` is the only second face, and only for genuine stamps —
  hostnames, URLs, timestamps, probe IDs, where character disambiguation actually
  matters. Never as a costume for "technical".

## Composition rules

- **The diagram is the layout.** Track runs at 0°, 45°, or 90° only — the drafting
  standard of the artifact. Junctions, not gutters, mark transitions between regions.
- Panels are engraved rectangles: radius 2–3px, hairline rule, and a 1px nickel bevel
  (light top edge, dark bottom edge) where a panel is physically raised. Opaque steel.
- **Lamps bloom; nothing else does.** A lit route segment, aspect disc, or illuminated
  pushbutton carries a colored bloom because that is what a lamp does behind glass.
  Panels, cards, text, and borders never glow. Depth is offset-plus-blur shadow.
- Occupancy replaces the bar chart: a horizontal track of discrete lit sections, with
  the route-set threshold marked on the rail.
- The score is a **block instrument** — a needle dial with named zones, not a ring.
- History is a **train register**: a ruled book, times in the left column.
- The **train describer** (14-segment berths stepping a 4-character code) marks any
  live or in-progress process.

## Motion

The world's native motion is a filament and a relay, and the page gets it once,
orchestrated — not scattered hovers.

- **Lamp on** 140ms with a brightness overshoot at 60% (filament inrush).
  **Lamp off** 260ms with a slow tail (a cooling filament, never a linear fade).
- **Route chain**: each segment lights 55ms after the one before it, so illumination
  reads as travel and as causality. This is the signature moment.
- **Point machine** 380ms with a mechanical snap for anything that switches a path.
- **Describer step** 90ms blank, then the new code.
- **Scroll is traversal**: Lenis-smoothed scroll advances a train down the landing's
  spine, and each region lights as the train enters its block. Content is visible by
  default; the lamps are the enhancement.
- `prefers-reduced-motion` collapses chains to a single state change and stops the
  traversal, keeping every lit state readable.

## Do not

- No bloom on anything that is not a lamp. No glass or blur as decoration — panel
  steel is opaque; `backdrop-filter` is for a genuine overlay scrim only.
- No gradient text. Signage lettering is flat paint; emphasis is weight, width, size.
- No track at angles other than 0/45/90.
- No same-size icon-heading-text cards as page structure, and no engraved plate used
  as a section eyebrow — plates identify controls, not prose.
- Lamp roles never swap: green is proceed/action, white is you, amber is caution, red
  is occupied, blue is annotation.
- No level-crossing kitsch, no steam nostalgia, no CRT phosphor, no ASCII.

## Compatibility

Token names in `src/app/globals.css` are the API — landing, dashboard, scan, and Studio
all consume them. The previous world's token names survive as aliases onto the new
roles so no surface breaks. shadcn HSL vars stay mapped. The print remap turns the
panel into a light report document. Playwright test ids preserved: `home-dashboard`,
`home-brand-card`, `home-run-card`, `preview-sample-cta`, `footer`.
