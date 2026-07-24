# Design

<!-- impeccable:design-schema 1 -->

## Visual World

**Results Night** — the graphics package of an election-results broadcast, adapted
to answer-engine intelligence. The interface is the dark studio wall: luminous tally
graphics on blue-black, a live crawl, declaration stamps. Share-of-AI is vote share;
rivals are parties; the 30 probes report in like constituencies; the verdict is the
projection. The register is a premium modern broadcast package (sharp panels, color
keylines, condensed numerals) — never kitsch, never a meme. Executive-legible first.

User-pinned: dark mode, always. Taste reference (not clone): impeccable.style —
restraint, metallic accent, large confident type.

## Palette

Studio surfaces (blue-black, not warm graphite):

- `--bg-0` #0A0E14 page · `--bg-1` #101623 panel · `--bg-2` #16202E raised ·
  `--bg-3` #1D2A3C active · borders #1C2736 / #283850 / #3A5273
- Text: #E8EDF4 / #96A5BA / #64748C

Roles (color is party identity — never decorative):

- **Gold** #F0B429 — the declaration. CTAs, projections, the wordmark tick, links.
  The only interactive accent.
- **Teal** #35E0C5 — YOU. Your brand's party color wherever you appear in data.
- **Signal red** #FF5D45 — RIVALS / trailing.
- Leading/good #3ECF7A · warn #E8A23D · info #4DA3FF
- The majority/threshold line is dashed white — it marks the visibility threshold
  on every tally.

## Typography

- **Display / numerals**: Barlow Condensed 600–700, uppercase for straps and
  headlines, tabular numerals for tallies. This face carries the broadcast voice.
- **Body**: Geist 400/500 — executive-legible, sentence case.
- **Mono**: Geist Mono — timestamps, probe IDs, data stamps only. Never as costume.

## Composition rules

- Panels are sharp (radius 3–6px) with hairline borders; a 3px party-color keyline
  may sit on a panel's top edge (never left/right).
- Section kickers are broadcast straps: condensed caps on a gold-keyline strap.
  Not an eyebrow grammar — straps mark segments, like a rundown.
- The crawl (bottom-of-hero marquee of probe results) is a durable device.
- The LIVE bug (pulsing red dot + caps) marks live/simulated data surfaces.
- Tally bars: horizontal, party-colored fill, name + count + gap, threshold line.
- **Role colors are not scales.** When a chart encodes magnitude (heatmap cells,
  graded ring segments, intensity fills), only YOUR series may ramp in teal.
  Rival magnitudes ramp on neutral luminance (graphite steps), never on red — a
  "hot" rival cell must read as a quantity, not as a party. Red stays reserved
  for the rival/trailing role itself.
- One orchestrated motion moment: tallies counting/filling on reveal. Crawl runs
  continuously. Everything else is restrained. `prefers-reduced-motion` respected.

## Do not

- No neon glow halos, no gradient text, no glass decoration.
- No political party colors (saffron/BJP green/Congress) — party colors here are
  product roles only (gold/teal/red).
- Teal and red never mark anything except you/rivals+trailing; gold never marks data,
  only declarations and actions.

## Compatibility

Token names in `src/app/globals.css` are the API — landing, dashboard, scan, Studio
all consume them. shadcn HSL vars must stay mapped. Playwright test ids preserved.
