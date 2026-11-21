# UI lab decisions

> <!-- doc-status -->
> **Status: LIVE.** Locked 17 November 2026. The owner reviewed every card in the
> UI lab (`/ui-lab`, branch `test_UI`) and chose what the real application
> frontend uses. Build the frontend from this list. Anything marked **Rejected**
> is not to be used; anything marked **Open** is still being decided.

Run the lab: `npm run dev`, then open `/ui-lab`. Each card has a Replay button.
The review dock at the bottom switches scheme variants and component shape.

## Brand

| Item | Decision | Source |
| --- | --- | --- |
| Logo (Essence P mark + wordmark, rise-in animation) | Keep | `src/components/app/brand/PerceevLogo.tsx`, `logoGeometry.js` |
| Page loader (breathing mark, 300ms delay) for sign-in and long page loads | Keep | `PageLoader`, `PerceevLoader` in `PerceevLogo.tsx`; `src/app/portal/loading.tsx` |
| Colour roles | Keep | `src/styles/palettes.css` |

## Colour scheme

| Item | Decision |
| --- | --- |
| Base: Onyx / White (`data-palette="onyx"`) | Keep — this is the scheme |
| Shades (Carbon, Pitch, Ember, Frost, Slate) | **Open** — keep all available, not decided |
| Accents (Volt, Arcade, Electric, Ultra, Aqua, Pulse) | **Open** — keep all available, not decided |
| Component shape (Soft base; Edge, Pill) | Keep Soft as base; Edge and Pill **Open** |

## Entrances

| Item | Decision | Source |
| --- | --- | --- |
| Page arriving (placeholders sweep, page rises, parts stagger) | Keep | `animate-page-in`, `stagger-children` in `src/styles/motion.css` |
| Rolling numbers | Keep | `src/components/app/motion/RollingNumber.tsx` |
| Stat tile design: **Spark** | Keep | `StatTile variant="spark"` in `src/components/app/StatTile.tsx` |
| Stat tile designs Rail, Ring, Inverse, Plain | **Rejected** | — |
| Loading into content (shimmer, then content steps in) | Keep | `skeleton-shimmer` utility |
| Verify (captcha-style box → spinner → tick) | Keep | `src/components/app/motion/VerifyCheck.tsx` |

## Controls

| Item | Decision | Source |
| --- | --- | --- |
| Primary button: press, ripple, lift, spinner while busy, tick when done ("Save changes", "Run a scan") | Keep — the button style to build on | `src/components/ui/button.tsx`, `motion/ripple.ts` |
| Spinner | Keep | `src/components/ui/spinner.tsx` |
| Success tick | Keep | `SuccessCheck` in `spinner.tsx` |
| Copy button (drawn tick) | Keep | `src/components/app/CopyButton.tsx` |
| Outline, Secondary, Ghost button variants as showcased | **Rejected** for new work | — |
| Checkbox and radio: **small (standard) size** with fill, burst, drawn tick / bouncing dot | Keep | `checkbox.tsx`, `radio-group.tsx`, `motion.css` |
| Large checkbox / radio sizes | **Rejected** | — |
| Switch: **small sizes** | Keep | `switch.tsx` |
| Tabs (one sliding indicator, panel steps in) | Keep | `src/components/ui/tabs.tsx` |
| Dialog (emblem, stat strip, spring in) | Keep | `dialog.tsx`, `src/styles/shapes.css` |
| Dropdown menu (labels, icons, shortcuts) | Keep | `dropdown-menu.tsx`, `shapes.css` |
| Select (the "ChatGPT" picker) | Keep | `select.tsx` |
| Side panel (floating sheet) | Keep | `sheet.tsx`, `shapes.css` |
| Tooltip | Keep | `tooltip.tsx` |
| Toasts — all types (success, error, info, warning, action, loading → done) | Keep | `src/components/app/AppToaster.tsx`, `shapes.css` |
| Disclosure, fields and progress (accordion, collapsible, input, progress + rolling %) | Keep | `accordion.tsx`, `collapsible.tsx`, `progress.tsx` |
| Scan progress advancing animation | Keep | `progress.tsx`, `RollingNumber` |

## Navigation

| Item | Decision | Source |
| --- | --- | --- |
| Sidebar: sliding highlight pill, icon pop, hover lean-in, page arrives | Keep — exactly as built | `src/components/app/motion/SidebarActivePill.tsx`, `AppSidebar.tsx`, `motion.css` |
| Header section pill that follows scroll / click | Keep | `SectionNav` in `src/app/ui-lab/UiLab.tsx` |
| Route progress bar | Keep | `src/components/app/motion/NavigationProgress.tsx` |

## Scrolling

| Item | Decision |
| --- | --- |
| Row arrival: **Focus** (`reveal-focus`) | Keep |
| Rise, Slide, Flip | **Rejected** |
| Scroll progress bar, top-edge shade, back-to-top | Keep |

In the app: Focus is opt-in per list (`data-reveal="focus"`); the app shell
has the scroll progress bar, top-edge shade and back-to-top.

## Charts (Bklit, `src/components/charts`)

| Item | Decision |
| --- | --- |
| **Line trend** (`LineChart`) | Keep — use for trends |
| **Bar chart** (`BarChart`) | Keep — use where bars are needed |
| Area trend, rings, gauge | Not chosen for now |
| Sparkline: **Area** (`AreaSparkline`), hover to read | Keep |
| Line and Bar sparklines | **Rejected** |

Every portal chart now uses Bklit Line / Bar (Recharts removed). A numeric
`YAxis` and `ReferenceArea` were added beside the vendored charts.

## Library section

| Item | Decision | Source |
| --- | --- | --- |
| Text effects (blur-in headline, shimmer, scramble, sliding number) | Keep | `src/components/motion-primitives/` |
| Surface effect: **Tilt** | Keep | `motion-primitives/tilt.tsx` |
| Border trail, Spotlight, Magnetic glow | Not chosen |
| Scan in progress (anime.js dot grid) | Keep | `src/components/app/motion/DotGridPulse.tsx` |
| Morphing dialog | Keep | `motion-primitives/morphing-dialog.tsx` |
| Hold to delete, Slide to confirm | Keep | `kokonutui/hold-button.tsx`, `kokonutui/slide-to-confirm.tsx` |
| Background work status pill | Keep | `kokonutui/status-island.tsx` |
| Notification stack | Keep | `kokonutui/notification-stack.tsx` |
| Data cards: metric card ("Answers naming you"), uptime card ("Answer engines"), liquid gauge ("Scan budget") | Keep all three | `kokonutui/metric-card.tsx`, `uptime-card.tsx`, `liquid-gauge.tsx` |
| Inline alert, empty state | Keep | `kokonutui/inline-alert.tsx`, `empty-state.tsx` |
| Continuous tabs, labelled progress, onboarding checklist | Keep | `src/components/watermelon/` |

The data cards run on Perceev data (Overview and Usage) with no sample data in
the product. The notification stack is not used: the app has no real source of
stacked notifications.

## Where the system lives

- Tokens and scheme: `src/styles/palettes.css`, `app-theme.css`
- Motion: `src/styles/motion.css`
- Component shape: `src/styles/shapes.css`
- Chart tokens: `src/styles/charts.css`
- Review dock: `src/components/app/theme/PaletteSwitcher.tsx` (dev only)
- Library registries: `components.json`; licences: `THIRD_PARTY_NOTICES.md`
- Overview: `DESIGN.md`
