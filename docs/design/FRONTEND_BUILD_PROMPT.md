# Frontend build prompt — Perceev UI rollout

> <!-- doc-status -->
> **Status: LIVE.** Written 18 November 2026 for the first implementation run of the locked UI (`docs/design/UI_LAB_DECISIONS.md`). Hand everything below the line to the implementing model as its brief.

---

## 0. Who you are and what this job is

You are implementing the visual and motion system for **Perceev**, a Next.js app that measures how often AI answer engines name a customer's brand. The look and motion were designed, reviewed and **locked** in an interactive UI lab. Your job is to **roll the locked choices out across the real application**, on a new `dev` branch, without changing what the app does.

You are not designing anything. Every visual decision is already made. If something is not covered here or in the decisions doc, **do not invent it** — leave it as it is and list it in your final report under "Not covered".

Read these files before writing any code, in this order:

1. `CLAUDE.md` — project rules, including the **secrets rule** (binding; see §2).
2. `docs/design/UI_LAB_DECISIONS.md` — the locked keep / reject list. **This is your spec.**
3. `DESIGN.md` — visual authority, scheme, motion and component-library notes.
4. `src/app/ui-lab/UiLab.tsx` and `src/app/ui-lab/LibraryDemos.tsx` — working reference implementations of every approved item. When unsure how to use a component, copy how the lab uses it.
5. `src/styles/palettes.css`, `src/styles/motion.css`, `src/styles/shapes.css`, `src/styles/charts.css` — the system itself.

To see the reference live: `npm run dev`, open `http://localhost:3000/ui-lab`. Every card has a Replay button.

---

## 1. Stack and layout (facts — do not change them)

- Next.js 15 (App Router), React 19, TypeScript + some JSX, Tailwind CSS 4, shadcn `base-nova` style on **Base UI** (`@base-ui/react`), not Radix.
- Animation: **`motion`** package, imported from `"motion/react"`. `framer-motion` is uninstalled — never import it. `animejs` v4 is installed for the scan grid only.
- Path aliases: `@/` → `src/`. The `cn` helper is `@/shared/utils`. **There is no `src/lib/`** — do not create one.
- Folders:
  - `src/app/` — routes. Customer app is `src/app/portal/*`. Public site is `src/app/page.js`, `/scan`, `/methodology`, etc.
  - `src/components/ui/` — the 32 shadcn primitives (button, dialog, tabs, checkbox…). Already restyled and animated.
  - `src/components/app/` — shared app components (`StatTile`, `PageFrame`, `PageHeader`, `EmptyState`, `CopyButton`, shell, brand, motion helpers).
  - `src/components/app/motion/` — `RollingNumber`, `VerifyCheck`, `DotGridPulse`, `SidebarActivePill`, `NavigationProgress`, `ripple.ts`.
  - `src/components/charts/` — **Bklit** chart library (vendored). Import from `"@/components/charts"`.
  - `src/components/motion-primitives/`, `src/components/kokonutui/`, `src/components/watermelon/` — vendored component libraries.
  - `src/components/portal/` — portal pages' components. `src/components/portal/ui.jsx` is a **legacy facade** (`Stat`, `Button`, `Badge`, `ProgressBar`, `Skeleton`…) used by older pages.
  - `src/styles/` — the CSS system (imported by `src/app/globals.css`).

---

## 2. Hard rules (breaking any of these fails the run)

1. **Secrets.** Never print, quote, cat or grep a credential. Exclude `.env*` from every recursive search (`rg --glob '!.env*'`, `grep -r --exclude='.env*'`). Prefer `git grep`. Never use `--no-ignore`, `-uu` or `--hidden` at the repo root. Never stage `.env`, `.env.local`, `.env.*.local` or `supabase/.temp/`. If a secret ever appears in output: stop, do not repeat it, name the file and variable in your report.
2. **No behaviour changes.** Do not touch API routes (`src/app/api/**`), `src/server/**` logic, `src/shared/**` business logic, Supabase migrations, the worker, auth, billing or data fetching. You change presentation only: markup, classes, which presentational component is used.
3. **Do not change data semantics on screen.** An unknown value stays an em dash "—", never `0`. "Not measured", "insufficient sample" and "measured zero" stay distinct. Simulated data stays labelled. Copy text stays the same unless this brief says otherwise.
4. **No new dependencies.** Everything you need is installed. Do not run `npm install <pkg>`. If you believe one is needed, stop and report it.
5. **Do not add components from registries** unless this brief names them. If you do run `npx shadcn add`, the CLI will (a) append colour variables and `@custom-variant dark (&:is(.dark *));` to `src/app/globals.css` and (b) create `src/lib/utils.ts`. **Revert both** every time.
6. **Do not edit vendored library internals** (`src/components/charts/*`, `kokonutui/*`, `motion-primitives/*`, `watermelon/*`) except to fix a type error or to replace hardcoded colours with tokens. Wrap or configure them from the outside instead.
7. **No hardcoded colours** in app code. Use tokens: `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`, `var(--chart-you)`, `var(--chart-rival-1..3)`, `var(--success)`, `var(--destructive)`, `var(--warning)`. Status colours (green/amber/red) are only for real status.
8. **Respect reduced motion.** Everything in `motion.css` already handles `prefers-reduced-motion`. Any new animation you add must too.
9. **Rejected items must not be used in new or changed code** (see §5).
10. **Keep these guard tests green** — they encode real constraints:
    - `src/components/ui/uiInventory.test.mjs`: every primitive in `src/components/ui/` starts with `"use client";` and keeps its licence header. Do not remove headers.
    - `src/components/portal/uiFacadeParity.test.mjs`: `ui.jsx` `Button` classes must contain the `button.tsx` base/variant/size classes. If you change `button.tsx` classes, mirror them in `ui.jsx`.
    - `src/shared/theme/tokens.test.mjs`: `src/styles/app-theme.css` keeps its light `--primary: #3730ce` and contrast rules. Do not edit `app-theme.css` tokens; the Onyx scheme overrides them from `palettes.css`.
    - `src/server/lightDesign.test.mjs`: `src/app/layout.js` imports are stubbed by name. If you add an import to `layout.js`, add it to that test's module map.
    - `src/server/docStatus.test.mjs`: every new doc under `docs/` needs the `<!-- doc-status -->` header block.
    - `src/shared/landingHonesty.test.mjs`: its harness only resolves `.js`/`.jsx`. Public-site components (`src/components/landing/*`) must not import `.tsx` files.
    - `src/server/renderHarness.mjs` passes `@/components/app/motion/*` through as plain children. Other new imports in harness-tested components must be added to that test's module map, never silently stubbed.

---

## 3. Branch workflow

The feature branches currently in progress will merge into `main` first. Then:

```bash
git fetch origin
git switch main && git pull --ff-only
git switch -c dev
git merge --no-ff origin/test_UI -m "Merge test_UI: locked UI system into dev"
```

- Resolve conflicts by keeping **both** sides' behaviour: new features from `main`, visual system from `test_UI`. For a primitive in `src/components/ui/`, take `test_UI`'s classes and re-apply any new props/logic from `main`.
- After the merge: `npm install`, `npm run typecheck`, `npm test`, `npm run lint`. All must pass before you start §6. Fix merge fallout first and commit it separately (`Fix test_UI merge fallout`).
- Work in small commits, one per task in §6, each with a clear message. Push `dev` only when the owner asks. **Never push to or merge into `main`.**

---

## 4. The system you are rolling out (already built — use it)

### Colour
- Base scheme **Onyx / White** is set on `<html data-palette="onyx" data-shape="soft">` in `src/app/layout.js`. It is dark on every page and in every theme preference.
- Shades (Carbon, Pitch, Ember, Frost, Slate), accents (Volt, Arcade, Electric, Ultra, Aqua, Pulse) and shapes (Edge, Pill) are **still undecided**. Keep them working, keep the dev-only review dock (`PaletteSwitcher`), do not pick one. Your code must look right under every variant — which it will if you only use tokens.

### Motion utilities (`src/styles/motion.css`)
- `animate-page-in` — page arrival. `stagger-children` — children rise in order (short fixed lists only). `animate-rise-in`, `animate-fade-in`.
- `skeleton-shimmer` — loading placeholder (already on `Skeleton`).
- `reveal-focus` — **the chosen scroll reveal**. `reveal-on-scroll`, `reveal-slide`, `reveal-flip` are rejected.
- `scroll-progress`, `scroll-edge` — scroll indicators.
- `motion-lift` — interactive card hover lift.
- Primitives already animate themselves: button press/ripple/busy/success, checkbox and radio fill+burst+tick, switch, tabs indicator, dialogs, menus, select, tooltip, sheet, accordion/collapsible, progress.

### Component shape (`src/styles/shapes.css`)
- Restyles dialogs, menus, side panels, toasts and cards by `data-slot`. Don't fight it with inline radii/shadows.
- `data-slot="dialog-emblem"` — the icon badge at the top of a dialog. Use it in dialogs that are about one thing (a scan, a question, a report).

### Key components
| Need | Use | Import |
| --- | --- | --- |
| Headline number tile | `StatTile variant="spark"` with `series` | `@/components/app/StatTile` |
| Animated number | `RollingNumber` | `@/components/app/motion/RollingNumber` |
| Primary action with busy / done state | `Button pending success` | `@/components/ui/button` |
| Copy | `CopyButton` | `@/components/app/CopyButton` |
| Trend chart | `LineChart`, `Line`, `Grid`, `XAxis`, `ChartTooltip` | `@/components/charts` |
| Bar chart | `BarChart`, `Bar`, `BarXAxis`, `Grid`, `ChartTooltip` | `@/components/charts` |
| Inline trend | `AreaSparkline` (hover to read) | `@/components/charts` |
| Page / long load | `PageLoader` | `@/components/app/brand/PerceevLogo` |
| Scan running visual | `DotGridPulse` + `TextShimmer` | `@/components/app/motion/DotGridPulse`, `@/components/motion-primitives/text-shimmer` |
| Background task pill | `StatusIsland` | `@/components/kokonutui/status-island` |
| Destructive confirm | `HoldButton` | `@/components/kokonutui/hold-button` |
| Spend confirm | `SlideToConfirm` | `@/components/kokonutui/slide-to-confirm` |
| Notifications list | `NotificationStack` | `@/components/kokonutui/notification-stack` |
| Failed checks | `InlineAlert` | `@/components/kokonutui/inline-alert` |
| Empty list | Kokonut `EmptyState` | `@/components/kokonutui/empty-state` |
| Setup steps | `OnboardingChecklist` | `@/components/watermelon/onboarding-checklist` |
| Multi-step label progress | `LabeledProgressIndicator` | `@/components/watermelon/labeled-progress-indicator` |
| Row → detail morph | `MorphingDialog*` | `@/components/motion-primitives/morphing-dialog` |
| Hero / feature card lean | `Tilt` | `@/components/motion-primitives/tilt` |
| Text reveal | `TextEffect`, `TextShimmer`, `TextScramble`, `SlidingNumber` | `@/components/motion-primitives/*` |
| Captcha-style verify | `VerifyCheck` | `@/components/app/motion/VerifyCheck` |
| Usage meter | `LiquidGauge` | `@/components/kokonutui/liquid-gauge` |
| Scrubbable KPI card | `MetricCard` | `@/components/kokonutui/metric-card` |
| Engine status strip | `UptimeCard` | `@/components/kokonutui/uptime-card` |

**Known pitfalls with these components:**
- `RingChart` and `Gauge` (Bklit) and anything using `NumberFlow` render a custom element that **mismatches server HTML**. Render them after mount (see `useMounted` in `LibraryDemos.tsx`). Ring and gauge are not chosen anyway — avoid them.
- Kokonut `MetricCard`, `UptimeCard`, `NotificationStack`, `EmptyState`, `InlineAlert` ship **built-in sample data** when props are omitted. Always pass real data or don't render them. Never show their sample numbers to a customer.
- Kokonut `IslandTask.status` is `"running" | "done" | "error"`.
- Bklit charts take `data` as an array of objects; time-series x values must be `Date` objects under a `date` key (or set `xDataKey`). Colours: `stroke="var(--chart-you)"` for the customer's brand, `var(--chart-rival-1)` etc. for rivals.

---

## 5. Locked decisions (summary — the full list is `UI_LAB_DECISIONS.md`)

**Keep and use:** logo and page loader; colour roles; page entrance + stagger; rolling numbers; **Spark** stat tile; loading shimmer; verify; primary button with press/ripple/busy/success (the "Save changes" and "Run a scan" style); spinner; success tick; copy button; **small** checkbox, radio and switch; sliding tabs; dialog; dropdown menu; select; side panel; tooltip; all toast types; disclosure/fields/progress; sidebar sliding pill; section pill; route progress bar; **Focus** scroll reveal; **Line** and **Bar** charts; **Area** sparkline with hover; text effects; **Tilt**; dot-grid scan visual; morphing dialog; hold-to-delete; slide-to-confirm; status pill; notification stack; metric card, uptime card, liquid gauge; inline alert; empty state; continuous tabs, labelled progress, onboarding checklist.

**Rejected — do not use in new or changed code:** Rail / Ring / Inverse / Plain stat tiles; outline, secondary and ghost button variants *as a design choice* (existing usages may stay; don't add new ones, and where a page has several equal buttons prefer the primary for the main action and a plain text link for the rest); large checkbox/radio sizes; Rise, Slide, Flip scroll reveals; Line and Bar sparklines; ring chart; gauge; area trend chart; border trail; spotlight; magnetic glow.

**Open — leave switchable, don't decide:** shades, accents, Edge and Pill shapes.

---

## 6. Tasks (do them in order, one commit each)

For each task: make the change, run `npm run typecheck` and the relevant tests, open the affected page in the browser (`npm run dev`), check light/reduced-motion behaviour, commit.

### T1 — Scroll reveal: switch Rise → Focus
In `src/styles/motion.css`, the rule under `@supports (animation-timeline: view())` applies `scroll-rise` to `[data-surface="app"] #app-content :is([data-slot="card"], .pv-card)`. Change it to use the Focus animation (`scroll-focus`, range `cover 0% cover 100%`) **but only for list rows and cards below the first screen** — cards above the fold must never start blurred. Simplest safe approach: apply `reveal-focus` only to cards inside elements marked `data-reveal="focus"`, and add that attribute to long lists (questions list, scans list, keyword tables' card wrappers, content library). Verify the first screen of every portal page is sharp on load.

### T2 — Stat tiles → Spark
Replace headline-number tiles with `StatTile variant="spark"`:
- `src/components/portal/ui.jsx` `Stat` — keep its props and its em-dash rule; render a `StatTile` internally (pass `label`, `icon`, `value`, `suffix`, `sub`). Add optional `series` and `delta` props, passed through. Keep the `pv-card pv-stat` hook classes on the outer element so existing tests and CSS still find it.
- `src/components/portal/overview/KpiRow.jsx` — pass `series` from the scan history already in `overview.scans` (visibility % per scan, oldest first) to the AI visibility tile, and `delta` derived from the existing `visibilitySub` logic. Only pass a series when there are ≥2 real points.
- Other `Stat` users (`BacklinksOverviewPanels.tsx`, `gsc/PerformanceCard.jsx`, `scans/MockScanPanel.jsx`) inherit the new look through the facade; check they render.
Do not fabricate series data. No series → no sparkline.

### T3 — Charts: Recharts → Bklit Line / Bar
Migrate these to Bklit, keeping every axis label, tooltip value format, legend meaning and empty/unavailable state:
- `src/components/portal/rank-tracking/RankTrendChart.tsx` → `LineChart`
- `src/components/portal/rank-tracking/RankTrackingOverview.tsx` (stacked area of position buckets) → `BarChart stacked`
- `src/components/portal/analytics/OrganicOverviewCard.tsx` → `LineChart`
- `src/components/portal/keywords/research/AreaTrendChart.tsx` → `LineChart`
- `src/components/portal/backlinks/BacklinksPageCharts.tsx`, `TrackedHistoryPanel.tsx` → `LineChart` for time series, `BarChart` for categories
- `src/components/portal/usage/UsageChart.tsx` → `BarChart stacked` (keep the "unknown cost" series visually distinct — use `var(--chart-rival-2)`)
- `src/components/perceev/charts/TrendChart.jsx` → `LineChart`
Rules: customer brand = `var(--chart-you)`; rivals = `var(--chart-rival-1..3)`; a missing point stays a gap (don't connect nulls into zeros). Do not delete `src/components/ui/chart.tsx` or `ChartAxes.tsx` until nothing imports them; then delete them **only if** no test references them. Leave `recharts` in `package.json` (removing deps is out of scope).

### T4 — Loading states
- Every portal route's loading spinner → `PageLoader` for full-page waits (`src/app/portal/loading.tsx` already exists; add the same for any route group with its own layout).
- In-card loading → `Skeleton` (shimmer is automatic). Remove remaining `animate-pulse` / `animate-spin` usages in `src/components/portal/**` in favour of `Skeleton` / `Spinner`.
- Lists that appear after loading → wrap the list in `stagger-children` (only when ≤ 8 items are first shown).

### T5 — Running scan
Wherever a scan in progress is shown (`ScanProgressCard`, `ScanRunningCard`, the overview's running state, `src/components/portal/useScanTracker.js` consumers):
- Show `DotGridPulse` with a `TextShimmer` label naming the current stage (the stage names already exist in the scan progress code — reuse them, don't invent).
- Keep the existing determinate `Progress` bar and its rolling percentage.
- Add a `StatusIsland` in the app shell (top centre of `#app-content`) that lists running background work the app **already tracks** (running scan; exports if tracked). If nothing is tracked, render nothing.

### T6 — Confirmations
- **Destructive** actions that currently use `AlertDialog` / `ConfirmDialog` / `InlineConfirm` (delete scan, remove question, remove team member, disconnect integration…): replace the final confirm button with `HoldButton` inside the existing dialog. Keep the dialog, its text and its cancel path. `holdDuration` ≈ 1200ms.
- **Spending** actions (`src/components/app/cost/PricedActionButton.tsx` and its 15 callers): add an option to confirm with `SlideToConfirm` showing the price in the label (e.g. "Slide to run scan · $4.20"). Use it only where the action spends money. Keep the existing price review / spend-refused logic exactly as is; the slider only replaces the final click.

### T7 — Dialogs and detail views
- Add `data-slot="dialog-emblem"` badges to dialogs that are about one object (run scan, scan details, question details, report share).
- Where a list row opens a read-only detail view (scan rows, question rows), use `MorphingDialog` so the row grows into the detail. Editing flows keep the normal `Dialog`.

### T8 — Empty states, alerts, onboarding
- Empty lists: use Kokonut `EmptyState` with real title/description copy from the current empty state (44 portal files use the existing `EmptyState` — convert the main list pages first: questions, scans, keywords, content, backlinks; list the rest in your report).
- Crawler / robots / llms.txt check results (site audit, onboarding website step): `InlineAlert` with the real checks. Its retry must call the existing re-check function; if there is none, don't render a retry.
- Overview setup checklist (`src/components/portal/overview/SetupChecklist.tsx`): render with Watermelon `OnboardingChecklist`, steps from the existing checklist model.

### T9 — Usage and engines
- `src/app/portal/usage`: add `LiquidGauge` (read-only) for budget used vs. budget, from existing usage data. If there is no budget, skip it.
- Overview or scans page: `UptimeCard` showing per-engine collection status **only if** per-engine per-day status already exists in the data. If not, skip and report.
- `MetricCard`: use on the overview for "Answers naming you" only if daily data exists. Otherwise skip and report.

### T10 — Public site
- Hero/feature cards on `src/app/page.js` → wrap the main sample-answer card in `Tilt` (rotationFactor ≈ 6).
- Headline → `TextEffect per="word" preset="fade-in-blur"` (same text).
- Remember rule 2.10: landing components must not import `.tsx`. If a `.tsx` component is needed on a landing page, render it from the page file (`src/app/page.js`), not from `src/components/landing/*`.

### T11 — Sweep
- `git grep -n "framer-motion"` → must be empty outside tests' comments.
- No `bg-white`, `text-black`, hex colours or `rgb(` in files you changed (vendored libraries excepted).
- No usage of rejected items in changed files.
- Every changed page checked at 375px wide: no horizontal scroll, dock doesn't cover primary actions.

---

## 7. Verification (must pass before you report done)

```bash
npm run typecheck
npm test
npm run lint
```

Then in the browser (`npm run dev`):
- `/ui-lab` still renders every card with no console errors.
- Every portal route you touched: loads, no console errors, no hydration warnings, first screen sharp (no blur), numbers roll, charts draw in, tooltips work.
- Switch the review dock through 2 shades, 2 accents and all 3 shapes: nothing becomes unreadable, nothing hardcoded stays white/black.
- macOS "Reduce motion" on (or DevTools → Rendering → prefers-reduced-motion: reduce): nothing moves or blurs; everything is still visible and readable.
- Keyboard only: every new control (hold button, slider, morphing dialog, status pill) is reachable and operable, with visible focus.

If you cannot log in to the portal locally, say so in the report and list which routes you could not check in the browser. Do not create accounts or use real credentials.

---

## 8. Final report format

Reply with:

1. **Branch and commits** — branch name, list of commit hashes + one-line messages.
2. **Done** — per task T1–T11: what changed, files touched.
3. **Skipped / not covered** — each with the reason (e.g. "no per-engine daily data, UptimeCard skipped").
4. **Checks** — exact output summary of typecheck / test / lint; which routes were checked in the browser and which were not.
5. **Risks** — anything you are unsure about, especially data-semantics (em dash vs 0, gaps vs zero) and conflicts resolved during the `test_UI` merge.
6. **Secrets** — confirm no `.env*` file was read, printed or staged. If anything leaked, name file and variable (never the value).

Do not claim something works unless you ran it. If a test fails and you cannot fix it, report the failing test name and the decisive error line.
