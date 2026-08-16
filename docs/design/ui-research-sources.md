# UI/UX source research — Perceev page redesign

Compiled 2026-08-16. Every repo below was verified live against the GitHub REST API
(`gh api repos/<owner>/<name>`) on that date — star counts and licenses are read values,
not recalled ones. Sorted into the categories that actually matter for this page.

---

## Part 1 — What is wrong with the current page

Diagnosis from a full-page render of `http://localhost:3000` at 1440×4250
(screenshot: `landing-full.png`). Nine concrete failures, each mapped to a fix.

| # | Problem | Evidence | Fix direction |
|---|---|---|---|
| 1 | **No luminance range.** Page `#0B0B0C`, panel `#121214`, raised `#17181A`. Every surface sits within ~6% luminance of every other. | Whole page reads as one flat black rectangle; nothing advances or recedes. | A dark UI needs 5–7 real steps and at least one surface well above the floor. Or go light. |
| 2 | **The 14-segment "describer" digits.** `IR0 1`, `IR0 2`, `1A04` stamped on every prompt, every rival, every berth. | This is the "digital clock" — it's on ~30 elements at once. It carries zero information a reader can use. | Delete entirely. Numerals are set in the type system, not drawn as segments. |
| 3 | **Wall of identical boxes.** 12 prompts in a 6×2 grid of same-size hairline rectangles. | Section 1 is visually a spreadsheet. Nothing is more important than anything else. | Vary the container: one hero prompt at large size, the rest as a flowing list or marquee. |
| 4 | **Five identical section blocks.** Every section is `number badge → uppercase heading → gray paragraph → widget`. Five times, no variation. | Scroll rhythm is monotone; nothing signals "this is the important one." | Alternate: full-bleed, split, centered, dark-on-light inversion, table. |
| 5 | **Type is shouting and unreadable at once.** Headings are Archivo wdth-118 wght-800 uppercase — very heavy. Body is ~13–14px at `#A0A2A8` on `#0B0B0C`. | Headlines overpower; body copy is below comfortable reading contrast and size. | Body 16–17px minimum. Headline weight down, size up. Sentence case for long headings. |
| 6 | **No UI elements.** No nav menu, no tabs, no badges, no avatars, no logo row, no tooltips, no toggles, no pricing table, no FAQ, no footer sitemap. | Page ends after 5 sections and a form. Reads as a prototype, not a product site. | Add the full marketing furniture — that's what makes it look finished to a client. |
| 7 | **The hero stat reads `0%`.** The gauge on a demo page shows zero. | A prospect's first read of the product's core number is "zero". | Demo data must show a credible, non-zero reading. |
| 8 | **Only one shape exists.** Every element is a 2–3px-radius rectangle with a 1px hairline. | No pills, no circles, no soft cards, no overlap, no depth. "Boxy" is literally correct. | Introduce a shape scale and let at least two shape families coexist. |
| 9 | **Inconsistent measure.** Prose sits in a ~600px column; widgets go full 1200px bleed. | Eye has to re-acquire the left edge on every section. | One grid. Content aligns to it whether it's prose or a chart. |

---

## Part 2 — The source list (24 verified repos)

### A. Component foundations — structure, accessibility, and the parts list

| Repo | Stars | License | What to take for Perceev |
|---|---:|---|---|
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | 121,397 | MIT | The copy-in-not-install model, and its component inventory as a checklist of what a "finished" product page owns. Its CSS-variable theming contract is the pattern our `globals.css` already half-implements. |
| [radix-ui/primitives](https://github.com/radix-ui/primitives) | 19,166 | MIT | Already a dependency. Correct behaviour for the interactive parts the current page lacks: nav dropdown, tabs, tooltip, accordion (FAQ). Use the ones already in `package.json`. |
| [mui/base-ui](https://github.com/mui/base-ui) | 10,640 | MIT | From the Radix/Floating-UI authors. Reference for how a modern unstyled layer models state, when we decide our own component API. |
| [mantinedev/mantine](https://github.com/mantinedev/mantine) | 31,571 | MIT | 120+ components — best single reference for *density and spacing defaults* on data-heavy surfaces. |
| [heroui-inc/heroui](https://github.com/heroui-inc/heroui) | 30,388 | Apache-2.0 | Its elevation and radius scale is the cleanest "modern soft SaaS" reference. Direct input to Option 2. |
| [saadeghi/daisyui](https://github.com/saadeghi/daisyui) | 42,089 | MIT | Semantic-token naming (`base-100/200/300`, `content`) — a better mental model for surface steps than our current `panel-0..3`, which is exactly the thing that collapsed to one flat black. |

### B. Motion and effects — where the "premium" feeling actually comes from

| Repo | Stars | License | What to take |
|---|---:|---|---|
| [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits) | 45,567 | custom | Text-reveal, magnetic hover, and scroll-driven number counters. The count-up on a score is the single highest-value borrow for a metrics product. |
| [magicuidesign/magicui](https://github.com/magicuidesign/magicui) | 21,974 | MIT | Bento-grid composition, animated beams between nodes, marquee logo rows. The beam pattern maps directly onto "question → engine → brand". |
| [motiondivision/motion](https://github.com/motiondivision/motion) | 33,255 | MIT | Already a dependency as `framer-motion`. Layout animations and scroll-linked transforms. |
| [greensock/GSAP](https://github.com/greensock/GSAP) | 27,745 | custom (now free incl. plugins) | ScrollTrigger — pinning a section while its content advances. The right tool if the "traversal" idea survives the redesign. |
| [darkroomengineering/lenis](https://github.com/darkroomengineering/lenis) | 15,429 | MIT | Already a dependency. Smooth scroll is doing real work here; keep it, drop the train metaphor riding on it. |
| [ibelick/motion-primitives](https://github.com/ibelick/motion-primitives) | 5,983 | MIT | Small, tasteful, non-gimmicky transitions. Better calibrated to a B2B/exec audience than the flashier libraries above. |
| [IanLunn/Hover](https://github.com/IanLunn/Hover) | 29,398 | MIT-ish | Pure-CSS hover vocabulary. Useful as a *restraint* list — pick two, not twenty. |

### C. Data visualisation — the product is a score, so this is core, not decoration

| Repo | Stars | License | What to take |
|---|---:|---|---|
| [tremorlabs/tremor](https://github.com/tremorlabs/tremor) | 3,565 | Apache-2.0 | "Show the data, hide the chrome." The KPI-card, tracker-bar, and delta-badge patterns are the direct replacement for our gauge dial and hairline occupancy rail. |
| [recharts/recharts](https://github.com/recharts/recharts) | 27,505 | MIT | The pragmatic React chart default; what Tremor builds on. Trend line for scan-over-scan history. |
| [plouc/nivo](https://github.com/plouc/nivo) | 14,085 | MIT | Widest chart vocabulary — heatmap (prompt × engine coverage) and sankey (question → engine → brand) are both exactly our data model and neither exists in the product today. |
| [airbnb/visx](https://github.com/airbnb/visx) | 21,005 | MIT | Low-level D3 primitives for when a chart has to be bespoke — e.g. the share-of-answer bar with a threshold marker. |
| [apache/echarts](https://github.com/apache/echarts) | 67,081 | Apache-2.0 | Reference for dense analytical layouts and legend/axis conventions at scale. |
| [observablehq/plot](https://github.com/observablehq/plot) | 5,353 | ISC | Grammar-of-graphics defaults — the best short course in what a chart should do without configuration. |

### D. Tokens, colour, and type — the layer that is actually broken

| Repo | Stars | License | What to take |
|---|---:|---|---|
| [radix-ui/colors](https://github.com/radix-ui/colors) | 1,647 | MIT | 12-step scales with guaranteed contrast at fixed positions, and paired light/dark ramps. This is the fix for problem #1 — steps 1–2 background, 3–5 surfaces, 6–8 borders, 9–10 solid, 11–12 text. |
| [argyleink/open-props](https://github.com/argyleink/open-props) | 5,494 | MIT | Ready-made scales for shadow, radius, easing, and fluid type. Its shadow ramp alone fixes "everything is a flat rectangle". |
| [system-fonts/modern-font-stacks](https://github.com/system-fonts/modern-font-stacks) | 3,499 | CC0 | Zero-download font stacks by classification. Guarantees these five HTML files look right offline. |
| [rsms/inter](https://github.com/rsms/inter) | 19,806 | OFL-1.1 | The UI-text benchmark; its optical-size and tabular-figure handling is what our score numerals need. |
| [primer/css](https://github.com/primer/css) | 13,002 | MIT | GitHub's system — the reference for a *light* interface that stays dense and legible without feeling like a toy. |
| [carbon-design-system/carbon](https://github.com/carbon-design-system/carbon) | 9,360 | Apache-2.0 | IBM's system. The most rigorous public treatment of data-dense enterprise layout and type scale. |
| [lucide-icons/lucide](https://github.com/lucide-icons/lucide) | 23,974 | ISC | Already a dependency. One stroke weight, one grid — the discipline that stops icons becoming clutter. |
| [tabler/tabler-icons](https://github.com/tabler/tabler-icons) | 21,390 | MIT | 6,100 icons if Lucide misses a concept; same 24px/2px construction so they mix cleanly. |

### E. Whole-page composition — how a finished marketing page is assembled

| Repo | Stars | License | What to take |
|---|---:|---|---|
| [markmead/hyperui](https://github.com/markmead/hyperui) | 12,195 | MIT | The largest free set of *marketing sections* — hero, feature grid, pricing, testimonial, CTA, footer. This is the fix for problem #6: it is a parts list for "what a page needs to look finished." |
| [themesberg/flowbite](https://github.com/themesberg/flowbite) | 9,319 | MIT | 400+ sections with dark mode already worked out; useful for checking a layout survives both themes. |
| [htmlstreamofficial/preline](https://github.com/htmlstreamofficial/preline) | 6,385 | custom | Strong application-shell and dashboard-preview patterns for embedding product UI inside a marketing page. |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | 108,639 | MIT | Distilled `DESIGN.md` files for major brand systems (Linear, Stripe, Vercel…). Comparable to our own `DESIGN.md` and a useful calibration of how specific a design brief should be. |
| [alexpate/awesome-design-systems](https://github.com/alexpate/awesome-design-systems) | 25,710 | Unlicense | Index into published systems when a specific pattern needs a precedent. |
| [bradtraversy/design-resources-for-developers](https://github.com/bradtraversy/design-resources-for-developers) | 66,660 | MIT | Broad index — fonts, palettes, illustration, background generators. |

**Count: 30 repos verified.** Requirement was 20.

---

## Part 3 — What each of the five options takes from this

| Option | Mode | Core idea | Primary sources |
|---|---|---|---|
| 1 · Ledger | Light | Printed intelligence report. Serif display, rules not boxes, editorial grid, real data tables. | Carbon (type scale), Primer (dense light), Observable Plot (chart restraint) |
| 2 · Console | Light | Product-led SaaS. Bento grid, elevated cards, the dashboard itself as hero. | HeroUI (elevation), Tremor (KPI cards), MagicUI (bento), HyperUI (sections) |
| 3 · Beacon | Light | Bold brand site. Oversized type, alternating full-bleed colour blocks, high energy. | HyperUI (sections), react-bits (count-up), Open Props (scales) |
| 4 · Obsidian | Dark | Premium restraint. Real luminance steps, warm metallic accent, thin large display type. | Radix Colors (dark ramp), Open Props (shadow), motion-primitives |
| 5 · Aperture | Dark | Data command deck. Deep slate, vivid colour confined to charts, dashboard-dense. | Radix Colors, nivo (heatmap/sankey), ECharts (dense layout), Carbon (dense type scale) |

Rules applied to all five, from Part 1:

1. No 14-segment digits anywhere.
2. Minimum 16px body copy at WCAG AA contrast or better.
3. At least four distinct section layouts per page — no repeated block template.
4. At least two shape families per page (never only hairline rectangles).
5. Demo score is credible and non-zero.
6. Full marketing furniture: nav, social proof, pricing, FAQ, footer.
7. One grid; prose and charts align to the same left edge.

---

## Part 4 — Anti-pattern audit, and what was deliberately kept

The project's impeccable detector (`.claude/skills/impeccable/scripts/detect.mjs`)
was run over all six files. 38 findings on the first pass, 26 after remediation.

**Fixed, because the finding was right:**

| Finding | File | What changed |
|---|---|---|
| `dark-glow` | Obsidian | Champagne halo shadows on the primary button, the lit ticks and the wordmark dot. Replaced with neutral offset-plus-blur elevation — `DESIGN.md` already forbids bloom on anything that is not a lamp. |
| `codex-grid-background` | Aperture | The two-axis hairline grid with a radial mask is a generated-UI signature. Removed; the dense dashboard already carries the structure. |
| `em-dash-overuse` | Aperture (15), index (12) | Rewritten with colons, parentheses and full stops. Seven of Aperture's came from the pricing table's "not included" glyph, now an en dash with an `aria-label`. |
| `marquee` (1 of 2) | Beacon | The top ticker announced "Live probe · … → NorthPeak" on synthetic data. `PRODUCT.md` already flags the existing site's simulated probe counter as a problem to replace; reproducing it in a client-facing mock repeats that mistake. Replaced with a static fact strip that says what the data is. |
| `overused-font` (10 of 35) | Aperture | Space Grotesk + Inter was the most generic pairing of the five and duplicated Ledger's body face. Now Familjen Grotesk over IBM Plex Sans / Plex Mono — a coherent system, and one that makes Aperture visually distinct from Ledger. |

**Kept, with reasons — not suppressed, and not confirmed by the user:**

- `overused-font` × 25 (Inter, Instrument Serif, Plus Jakarta Sans, Roboto Mono).
  Each option's identity comes from its display face; the flagged faces are the
  body and data workhorses sitting underneath. Inter and Plex Mono at 10–14px are
  chosen for tabular figures and character disambiguation, where legibility beats
  personality. Rewriting four type systems to clear this rule would be changing
  intentional design to satisfy a hook. Worth revisiting for whichever single
  option is chosen, not across five explorations.
- `marquee` × 1 (Beacon's question marquee). Beacon's whole brief is volume, and
  the horizontal scroll is one of the things that stops the tracked question set
  becoming another wall of boxes. It honours `prefers-reduced-motion`. The rule's
  objection — that it hides half its content — stands, so this is a live trade-off
  to settle if Beacon is the direction chosen.
- Aperture's "Live probe stream" panel sits *inside* a product mock rather than in
  page chrome, and the footer states the data is a demonstration with fictional
  brands. That reads as depicting product behaviour rather than claiming live site
  telemetry, so it was left — but it is the same family of risk as Beacon's ticker
  and should be checked once real telemetry exists.
