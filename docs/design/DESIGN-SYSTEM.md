# Perceev — design system

> <!-- doc-status -->
> **Status: SUPERSEDED-BY** [DESIGN.md](../../DESIGN.md). This document describes the earlier `design-options/prototype.src.html` prototype and names it the source of truth. It is not: none of its tokens appear in the shipped components, which use the Signal Box ramp from DESIGN.md. Kept for the prototype's measurements and rationale; do not implement from it.

**Reference implementation:** https://claude.ai/code/artifact/a5da71e6-0605-46a4-b955-7b548601fd4e
**Source of truth for markup and CSS:** `design-options/prototype.src.html` (2,651 lines, self-contained)
**Built artifact:** `design-options/perceev-prototype.html` — the source with fonts inlined
**Build step:** `node scripts/build-prototype.mjs`

---

## 0. How to use this document

You are implementing the Perceev frontend. Open the artifact link first and click through all
eight screens with the switcher at the bottom, then toggle the theme. Everything in this document
is measurable in that page — when this document and the prototype disagree, **the prototype wins**,
because every value here was read out of it rather than recalled.

The prototype is a static single file. Your job is to port it into the Next.js app, not to
redesign it.

> ### ⚠ Conflict you must resolve before starting
>
> `DESIGN.md` at the repo root still describes an earlier, **rejected** design world (the "Signal
> Box" — a railway interlocking panel, dark-only, with 14-segment display digits). It was rejected
> on 2026-08-16 as cluttered and boxy. `PRODUCT.md` likewise still records "the interface is dark
> mode" as binding; the current system is **light-first with a full dark theme**.
>
> Treat this document as authoritative over both for anything visual. Ask the user before rewriting
> `DESIGN.md` / `PRODUCT.md`, but do not build from them.

---

## 1. What the product is

Perceev is answer-engine intelligence. It asks Google AI Overview, ChatGPT and Perplexity **36
unbranded buyer questions** and reports which brand each answer recommends, keeping the answer text
verbatim as evidence. The headline metric is **share of AI** — the share of answers that name you.

Users are marketing leaders and CXOs at B2B companies, first vertical healthcare in India. They are
analysts, not developers. Every screen must be graspable in seconds.

Three ideas drive every design decision:

1. **The verdict is the product.** Every surface leads to or from the share-of-AI number.
2. **Show the evidence.** No score without the sentence that produced it.
3. **Unbranded or it doesn't count.** The neutrality of the probe is the trust story.

---

## 2. Typography

Two faces, both already in the repo at `src/app/fonts/`. **Self-host them.** Do not link Google
Fonts — the prototype runs under a CSP that blocks external hosts, and the app should not depend on
a third party for its brand face either.

| Role | Face | File | Usage |
|---|---|---|---|
| Display + body | **Archivo** (variable, wght 100–900, wdth 62–125) | `Archivo-VF.woff2` | Everything except data labels |
| Data / labels | **Spline Sans Mono** (variable) | `SplineSansMono-VF.woff2` | Numerals in columns, uppercase micro-labels, timestamps, domains |

```css
@font-face{
  font-family:'Archivo';
  src:url(/fonts/Archivo-VF.woff2) format('woff2-variations');
  font-weight:100 900; font-stretch:62% 125%; font-display:block;
}
@font-face{
  font-family:'SplineMono';
  src:url(/fonts/SplineSansMono-VF.woff2) format('woff2-variations');
  font-weight:300 700; font-display:block;
}
```

Archivo is deliberately set at **width 100** — the old rejected design used width 118 at weight 800
in uppercase, which is what made it shout. Same face, completely different voice.

### Scale

| Element | Size | Weight | Tracking | Line-height |
|---|---|---|---|---|
| `h1` | `clamp(38px, 5.4vw, 68px)` | 620 | −0.03em | 1.04 |
| `h2` | `clamp(30px, 3.9vw, 52px)` | 620 | −0.03em | 1.04 |
| `h3` | `clamp(20px, 1.7vw, 25px)` | 620 | −0.024em | 1.2 |
| `h4` | `17px` | 620 | −0.018em | 1.3 |
| body | `17px` | 400 | — | 1.65 |
| `.lede` | `clamp(17px, 1.35vw, 19.5px)` | 400 | — | 1.6 |
| `.tag` (label) | `11px` | 500 | **+0.14em**, uppercase | — |

All headings carry `text-wrap: balance`. Running prose stays near 65 characters.

**Watch out:** `ch` units resolve against the *element's own* font-size. Putting `max-width: 22ch`
on a wrapper whose font-size is 17px crushes a 52px heading into a one-word column. Constrain the
heading itself.

---

## 3. Colour

Neutrals carry a slight indigo bias so they read as chosen rather than inherited. Semantic colour
(good / caution / critical) is **separate from the accent** and never doubles as it.

### Light (the base palette)

| Token | Value | Use |
|---|---|---|
| `--paper` | `#F7F7FA` | Page ground |
| `--surface` | `#FFFFFF` | Cards, panels, nav |
| `--sunken` | `#EFEFF4` | Inset wells, chip grounds, track fills |
| `--ink-1` | `#0E1017` | Headings, primary text |
| `--ink-2` | `#474C5A` | Body |
| `--ink-3` | `#565C6D` | Secondary, labels |
| `--ink-4` | `#64697B` | Tertiary — still passes AA |
| `--line` | `#E2E3EB` | Default border |
| `--line-soft` | `#EDEEF3` | Internal dividers |
| `--line-strong` | `#CFD2DE` | Emphasised border, input outline |
| `--brand` | `#3730CE` | Accent, links, primary button |
| `--brand-lift` | `#5B54F0` | Hover |
| `--brand-tint` | `#EEEEFC` | Accent ground |
| `--brand-line` | `#D3D1F8` | Accent border |
| `--on-brand` | `#FFFFFF` | Text on `--brand` |
| `--card-brand` | `#3730CE` | The big indigo capability cards |
| `--card-brand-ink` | `#FFFFFF` | Text on those |
| `--card-brand-soft` | `#C7C4F6` | Secondary text / chart strokes on those |
| `--navy` | `#0C0E18` | Dark closing band + footer |
| `--navy-ink` | `#E9EAF2` | Text on navy |
| `--navy-dim` | `#949AB0` | Secondary text on navy |
| `--brand-on-navy` | `#A9A4FF` | Accent that still reads on navy |
| `--good` | `#0B7552` | Positive |
| `--warn` | `#8A5709` | Caution |
| `--crit` | `#B02F2F` | Negative |
| `--you` | `#3730CE` | **You**, in every chart, always |
| `--rival-1/2/3` | `#8A90A6` / `#B4B9C9` / `#D3D6E0` | Rivals, ramping down |
| `--none` | `#E5E7EF` | No brand named |

### Dark

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--paper` | `#0A0C12` | | `--brand` | `#7F79FF` |
| `--surface` | `#12151F` | | `--brand-lift` | `#A29CFF` |
| `--sunken` | `#07090E` | | `--brand-tint` | `#171734` |
| `--raised` | `#171B26` | | `--brand-line` | `#32307B` |
| `--ink-1` | `#EDEEF3` | | `--on-brand` | `#0A0A18` |
| `--ink-2` | `#AEB4C4` | | `--card-brand` | `#2A24A8` |
| `--ink-3` | `#8F96AB` | | `--card-brand-ink` | `#F2F1FF` |
| `--ink-4` | `#7C8398` | | `--card-brand-soft` | `#A9A5EE` |
| `--line` | `#1F2432` | | `--good` | `#3DBF93` |
| `--line-soft` | `#171B25` | | `--warn` | `#D9A445` |
| `--line-strong` | `#2C3242` | | `--crit` | `#E97070` |
| `--navy` | `#06080F` | | `--you` | `#7F79FF` |
| `--navy-dim` | `#8F96AB` | | `--rival-1/2/3` | `#737A94` / `#515770` / `#3B4054` |
| `--on-good` | `#04231A` | | `--none` | `#262B38` |

### Rules that are not negotiable

- **Every ink token is used on real content and every one clears WCAG AA** on both `--paper` and
  `--surface`. They were darkened specifically to fix 126 contrast failures. Anything lighter than
  `--ink-4` is a border colour, not a text colour. Do not lighten these to "soften" the UI.
- **Semantic hues were darkened** until they pass as text on their own tint. A status colour nobody
  can read is decoration.
- **`--you` is indigo everywhere, without exception.** Rivals ramp down the neutral scale. A rival
  never takes a semantic colour — losing a question is not an "error".
- Tokens that flip lightness between themes need a paired `--on-*` token. `--good` is dark in light
  mode and light in dark mode, so a glyph sitting on it uses `--on-good`, never hard-coded white.

---

## 4. Theming contract

The viewer has **three** states, not two. Get this wrong and the page renders one theme's text on
the other theme's ground.

```css
:root{ /* complete LIGHT palette — the base */ }

@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){ /* redefine tokens only */ }
}

:root[data-theme="dark"]{ /* the same redefinitions again */ }
```

- The default "system" setting stamps **nothing** on the root — only `prefers-color-scheme`
  separates light from dark there.
- The `:not([data-theme="light"])` guard makes an explicit light choice beat a dark OS.
- The third block makes an explicit dark choice beat a light OS.
- **Style components through tokens only.** A colour whose only definition sits inside a media query
  or `[data-theme]` block never applies in the unstamped state. That is the classic bug.
- `body` must set an explicit `background` from a token. A transparent body borrows the host ground.

---

## 5. Layout

| Token | Value |
|---|---|
| `--shell` | `1200px` (content max width) |
| `--pad` | `clamp(20px, 4vw, 48px)` (page gutter) |
| Radii | `--r-xs` 5 · `--r-sm` 8 · `--r-md` 12 · `--r-lg` 18 · `--r-xl` 24 · `--r-pill` 999 |
| Shadows | `--shadow-1` hairline · `--shadow-2` card lift · `--shadow-3` hero |

Grid helpers: `.grid` with `.g2` `.g3` `.g4` `.g-wide` (1.5fr 1fr) `.g-side` (1fr 340px).
All are `align-items: start` — a stretched panel whose body is taller than the row spills past its
own border.

**Give grid and flex children `min-width: 0`.** They default to `min-width: auto`, so one wide child
silently pushes its whole track past the viewport. Inputs are the usual culprit: `flex: 1 1 0` plus
`width: 0` is what actually lets an `<input>` shrink.

Breakpoints: `1080px` (dashboard grids collapse), `960px` (landing two-columns stack, sidebar goes
horizontal), `620px` (mock chrome trimmings drop).

---

## 6. Components

Class names are the prototype's. Port them as React components with the same structure.

### Core
| Class | What it is |
|---|---|
| `.btn` + `--primary` `--ghost` `--quiet` `--onbrand`, sizes `--sm` `--lg` | 46px pill, 6px lift on hover |
| `.chip` + `--you` `--good` `--warn` `--crit` | 24px status pill, mono uppercase, optional `.chip__led` dot |
| `.tag` | The mono uppercase micro-label. Used everywhere for eyebrows and metadata |
| `.field` | Pill input with an inline submit button |
| `.card` / `.panel` + `.panel__h` `.panel__b` | Surfaces |
| `.seg` | Segmented control (30/90/All) |
| `.filter` | Filter pill, active state is inverted ink |
| `.skel` | Loading placeholder — a calm opacity pulse, not a sweeping shimmer |

### Product
| Class | What it is |
|---|---|
| `.stat` | KPI tile: label, big tabular value, delta line |
| `.row` / `.rows` | Share bars. **Animate `transform: scaleX()`, never `width`.** `--w` is a ratio (`.41`) |
| `.tbl` | Data table. Every column after the label is right-aligned and tabular |
| `.qrow` | A tracked question: index, text, engine, verdict chip |
| `.src` | A cited source: domain, count, ownership chip |
| `.opp` | An opportunity card in Studio |
| `.gauge` | Engine coverage: a hairline, a filled segment, a dot, a tick at the 50% threshold |
| `.flow` | The question→brand ribbon diagram |
| `.cvn` / `.cve` | Agent canvas node and edge |
| `.sheet` | The hero answer card that types itself in |

### Chrome
`.nav` (sticky, blurred), `.app` (sidebar + main), `.side__i` (sidebar item), `.topbar`,
`.viewpad`, `.foot`.

---

## 7. Data visualisation

- Charts get the same care as type: a faint grid, labelled axes, an emphasised endpoint, tabular
  figures, and a legend naming real brands.
- **Never put `height="auto"` on an SVG.** It is not a valid length attribute; the chart ignores its
  viewBox ratio and stretches to fill, overflowing its panel. Size charts from CSS:
  `.chart{ display:block; width:100%; height:auto }`.
- Bands thinner than their own label need label positions clamped to a minimum separation (40px in
  the probe diagram), or the labels collide when a value is small.
- The occupancy strip and the tick rows that used to represent this data were **rejected** — they
  read as rows of boxes. Use the gauge (position on a scale) and the flow diagram (ribbons)
  instead. Do not reintroduce grids of same-size blocks as a chart type.

---

## 8. Motion

One easing curve: **`cubic-bezier(.22, .68, 0, 1)`**. Nothing bounces or overshoots — an overshoot
was flagged and removed for being the only tacky thing in the system.

| Movement | Duration |
|---|---|
| Reveal on scroll | 620ms |
| Count to a number | 900ms |
| Draw a trend line | 1200ms |
| Change screen | 380ms |
| Deck slide change | 420ms |
| Hover / small state | 150ms |

Rules:

- **Reveals are an enhancement, never a gate.** The hidden state is scoped under a `.js-anim` class
  that script adds on boot, so a script failure leaves a readable page instead of a blank one.
- `prefers-reduced-motion: reduce` collapses everything to a single state change and drops the
  pinned scroll section entirely.
- **Nothing auto-advances.** Content that moves itself while being read is a nuisance. An
  auto-scrolling ticker was removed for this reason (and because it implied live telemetry the
  product does not have).
- The capability deck is **scroll-driven**: a tall section with a pinned panel, where scroll
  progress maps to slide index. Slides move on the **Y axis only** — earlier cards rest 26px above,
  later ones 26px below, current at zero, so direction reverses for free. Dropped below 960px.

---

## 9. Screens

Eight, all in the prototype behind the bottom switcher.

| Screen | Route in the app | Contains |
|---|---|---|
| **Landing** | `/` | Hero with self-typing answer sheet · engine gauges · "the gap" flow diagram · scroll-pinned capability deck · evidence · FAQ · navy CTA · footer |
| **Scan** | `/scan` | Three states: entry → running → complete. The running state draws the flow diagram live |
| **Overview** | `/dashboard/[brand]` | 4 KPI tiles · share-of-AI trend · who holds the answer · coverage by engine · highest-value gaps |
| **Answers** | dashboard view | Filter pills · 36-question list · sticky verbatim panel with marked-up text |
| **Rivals** | dashboard view | Discovered-brand table · head-to-head |
| **Sources** | dashboard view | 4 KPI tiles · cited domains with ownership |
| **Studio** | dashboard view | **Agent canvas** (node graph) · opportunity queue · node inspector |
| **Components** | internal only | Colour, type, controls, data display, empty/loading/error states, motion |

The five product views share **one app shell** with an inner view router — the sidebar is real
navigation, not a picture of it.

### Notable: the agent canvas
An n8n-style node graph in Studio. Six nodes — Gap detected → Researcher → Strategist → Writer →
**Editor · you** → Publish & measure — plus a dashed **send-back loop** from the editor to the
writer. Nodes have ports, edges are SVG paths, the live edge animates, the human gate pulses, and
clicking a node drives the inspector.

**Node height must be fixed** (`142px`), not `min-height`. Ports sit at 50% height, so a node that
grows a line taller drags its port off the edge that connects to it.

The canvas sits on a dotted field at `22px` tiling. This is a deliberate exception to the
"no decorative grid backgrounds" rule, because it is an actual pannable canvas surface. A design
linter in this repo flags it; it has been reviewed and kept.

---

## 10. Demo data — keep it consistent

Every surface quotes the same reading. If you change one number, change all of them.

| Fact | Value |
|---|---|
| Brand | Brightwave (`brightwave.io`), healthcare, India |
| Tracked set | 36 unbranded questions, 12 per engine |
| Share of AI | **41%**, up 11 points |
| Answers naming you | **15 / 36** |
| NorthPeak | 12 answers · 33% |
| Lumen IQ | 6 answers · 17% |
| No brand named | 3 answers · 9% |
| Per engine | ChatGPT 6/12 · AI Overview 5/12 · Perplexity 4/12 |
| Rivals discovered | 7 (3 new) |
| Sources cited | 64, of which 6 are yours |
| High-intent lost | 9 |

15 + 12 + 6 + 3 = 36. The scan animation uses a fixed 36-verdict sequence so it lands exactly here.

**All brands are fictional and must stay recognisably so.** There are no real customers, logos,
testimonials or case studies — do not invent any. Where a panel shows fewer rows than its header
claims, state it honestly ("16 of 36 shown"), don't let the counts contradict each other.

---

## 11. Explicitly rejected — do not reintroduce

These were built, reviewed and thrown out. Re-adding any of them undoes a decision.

1. **14-segment "digital clock" display digits.** They were on ~30 elements and carried no
   information. The `Describer` component (`src/components/signal/Describer.jsx`) and every usage
   should be deleted.
2. **Rows of identical blocks as a chart.** Twelve tick marks per engine, thirty-six cells for the
   occupancy strip. Replaced by the gauge and the ribbon diagram.
3. **A pricing section on the landing page.** Removed entirely, including its CSS.
4. **Auto-scrolling tickers and marquees.**
5. **Bounce / elastic easing.**
6. **Glowing coloured shadows.** Depth is offset-plus-blur in a neutral colour, never a chromatic
   halo — that is the default "AI-generated UI" look.
7. **A click-stepped carousel** for the capability section. It must be scroll-driven.
8. **The dark-only "Signal Box" railway world** described in the root `DESIGN.md`.

---

## 12. Quality bar

The prototype currently holds all of these. Keep them holding.

- **Zero WCAG AA contrast failures** across all 8 screens × 2 themes. Check text against its true
  composited backdrop, and remember `color-mix()` computes to `color(srgb …)` with 0–1 floats —
  a naive parser reads those as near-black and reports false failures.
- **Zero horizontal overflow** at 1440px and 375px, in both themes.
- Visible keyboard focus (`:focus-visible`, 2px `--brand`, 3px offset).
- Wide content (tables, canvas, charts) scrolls inside its own container; the page body never
  scrolls sideways.
- No layout-property animation — `transform` and `opacity` only.

---

## 13. Porting notes

- Design tokens belong in `src/app/globals.css`. shadcn/ui HSL variable compatibility must be
  maintained; the repo already has ~30 Radix packages installed.
- Existing surfaces to replace: `src/app/page.js` (landing), `src/app/scan/page.js`,
  `src/components/dashboard/*` (929-line `DashboardShell.jsx` is the big one),
  `src/components/studio/*`, `src/components/landing/*`, `src/components/signal/*` (delete).
- **Test ids: there are ~115 of them in `src/`, not the five `PRODUCT.md` names.** Run
  `grep -roh 'data-testid="[^"]*"' src | sort -u` before you touch a component. `PRODUCT.md` lists
  only `home-dashboard`, `home-brand-card`, `home-run-card`, `preview-sample-cta`, `footer` — that
  list is badly out of date, and a rewrite that trusts it will break a lot of tests silently.
  Whole families exist for Studio (`studio-*`), agents (`agent-*`), crawlability, prompt metrics,
  and the scan form.
- Engines are configured per deployment via `ENGINES`. Every engine-facing surface must render
  whatever engines actually reported — never a hardcoded count of three.
- The tracked set is per-brand (`scan_schedules.prompt_target`, 10–100) and only ever grows
  additively, so score history stays comparable. Don't hardcode 36 in logic; it is a demo value.

## 14. Open items

- `DESIGN.md` and `PRODUCT.md` still describe the rejected world (see the warning at the top).
- The landing page's "live" framing must not imply telemetry that does not exist yet — the existing
  probe counter is simulated and flagged in `PRODUCT.md` for replacement.
  - **Resolved 2026-09-09 (R6.3.5), sentence kept for the trail.** Both facts it rests on expired on
    2026-08-16: `src/components/landing/ProbeCounter.jsx` was deleted with its stats strip in
    `5111219`, and `PRODUCT.md` no longer carries that flag. The landing page now makes no aggregate
    claim at all, enforced by `src/lib/landingProbeCounter.test.mjs`. The rule in the first clause
    still stands; only "the existing probe counter" and the `PRODUCT.md` cross-reference are stale.
- Studio's hero panel says "Live probe stream". It sits inside a product mock and the footer states
  the data is a demonstration, so it was kept — but re-check it once real telemetry exists.
