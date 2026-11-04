# F04 — Design system and app shell (OpenSEO UI/UX)

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F04 |
| Wave | 0 |
| Comparison rows covered | "UI/UX decision" (owner: match OpenSEO's customer app); "Frontend patterns worth taking" (one empty state with three kinds, reveal-on-hover, 16 px inputs, `notranslate`) |
| Depends on | F01 phase 1 (TypeScript, `tsconfig.json`, `src/lib/http/errors.ts`, `requireWorkspace`) for phase 2 onward; F01 phase 2 (`isFeatureEnabled`, `src/lib/features/names.ts`) for phase 4; the run-scan fix (`fix/run-scan-unapproved-panel`: `panel_not_approved` / `scan_already_running` codes) merged into `main` for phase 5. Phase 1 depends on nothing. |
| Blocks | F05, F06, and the UI phase of every later spec (F03 P4, F09 P3, F11 P3, F12 P3, …) |
| Reserved migrations | 055–059 — **unused** (F04 has no database objects) |
| Feature flag | none. F04 restyles existing surfaces; rollback is a revert. It provides the mechanism that hides other features' sidebar items until their flags are on. |
| Spend features | none |
| OpenSEO reference | `openseo:src/client/styles/app.css`, `openseo:src/client/lib/theme.ts`, `openseo:src/routes/__root.tsx`, `openseo:src/client/layout/*`, `openseo:src/client/components/{Sidebar,PageHeader,EmptyState,ErrorState,QueryState,SkeletonPresets,…}.tsx`, `openseo:src/client/components/ui/*`, `openseo:src/client/navigation/items.ts`, `openseo:src/client/features/projects/ProjectSwitcher.tsx`, `openseo:src/client/features/auth/AuthPage.tsx`, `openseo:components.json` at `c5f8db1` |

## 1. Summary

The customer app (portal, sign-in pages, onboarding) takes OpenSEO's look and behaviour: shadcn `base-nova` on Base UI, Tailwind 4 tokens in oklch, light/dark/system themes with a no-flash script, the inset sidebar with a workspace switcher, and the shared page components (page header, one empty state with three kinds, query state, skeleton presets, confirm dialogs). Perceev keeps its name, its logo and its indigo primary (`#3730CE`). The public marketing site stays exactly as it is through the React 19 and Tailwind 4 upgrade, proven by a layout snapshot diff. Every later feature builds its screens from these parts, so this spec is the floor the other 23 UI phases stand on.

## 2. What OpenSEO does (observed)

**Stack and configuration**

1. React 19, Tailwind 4, `tw-animate-css`, `@base-ui/react` ^1.8, `class-variance-authority`, `lucide-react`, `sonner` ^2, `recharts` ^3.8, `react-markdown` ^10 + `remark-gfm` ^4, `@tanstack/react-table` ^8.21, `papaparse` (`openseo:package.json:73-127`). `shadcn` ^4.21 is a devDependency whose stylesheet the app imports (`openseo:package.json:163`, `openseo:src/client/styles/app.css:3`).
2. `components.json` uses style `base-nova`, `rsc: false`, base colour `neutral`, CSS variables, icon library `lucide`, `menuAccent: "subtle"` (`openseo:components.json:1-24`).
3. Class names are merged by the npm package `cn` (`openseo:package.json:103`; e.g. `openseo:src/client/components/ui/button.tsx:3`). Its lockfile lists no `tailwind-merge` dependency (`openseo:pnpm-lock.yaml:3638`). **(inferred)** `cn` concatenates without resolving Tailwind conflicts; overrides that must win use `!` (e.g. `md:!m-0` in `openseo:src/client/layout/AppShell.tsx:114`).

**Tokens and global CSS** (`openseo:src/client/styles/app.css`)

4. Imports `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css` (`:1-3`). Dark variant is an attribute, not a media query: `@custom-variant dark (&:where([data-theme=openseo-dark], [data-theme=openseo-dark] *))` (`:8`). `--container-8xl: 88rem` (`:10-12`).
5. `@theme inline` maps every token to a colour utility and derives the radius scale from `--radius: 0.5rem` (`:14-62`).
6. Light tokens (`:64-105`): background `oklch(95.5% 0 0)`, card/popover white, foreground `oklch(20% 0 0)`, primary `oklch(50% 0.12 262)`, muted-foreground `oklch(20% 0 0 / 60%)`, destructive `oklch(65% 0.2 25)`, success/warning/info, border `oklch(92% 0 0)`, input `oklch(82% 0 0)`, five chart colours, sidebar `oklch(91% 0 0)` with accent `oklch(20% 0 0 / 8%)`. Dark tokens (`:107-146`) under `[data-theme="openseo-dark"]`.
7. Trend chart tokens `--trend-grid-color`, `--trend-axis-color`, fill opacities and tooltip colours (`:148-156`, dark `:343-351`).
8. `html, body` fill the viewport with `overflow: hidden` (`:158-165`); thin scrollbars in the text colour (`:167-171`); **16 px inputs** for every native control without `data-slot` so iOS Safari does not zoom (`:173-181`); `.pb-safe` (`:184-188`); **`reveal-on-hover`** utility: hidden until row hover or focus-within, always visible on coarse pointers (`:190-194`); touch-action rules (`:196-204`).
9. Tag chip colours (eight hues, `:206-272`) and keyword-difficulty tier colours `score-tier-na`, `score-tier-1`…`6` (`:274-341`), each with dark-theme text colours.

**Theme**

10. `ThemePreference = "system" | "light" | "dark"`, stored in `localStorage["theme-preference"]`; "system" removes the key; a failed write is kept in memory for the session (`openseo:src/client/lib/theme.ts:3-46`). Resolution sets `data-theme` on `<html>` (`:48-71`). `useThemePreference()` uses `useSyncExternalStore` and follows OS changes in system mode (`:73-129`).
11. A no-flash inline script built from the same constants runs first in `<head>` (`openseo:src/client/lib/theme.ts:131-142`, injected at `openseo:src/routes/__root.tsx:100-102`). `<html suppressHydrationWarning translate="no">` (`__root.tsx:98`) plus `<meta name="google" content="notranslate">` because machine translation rewrites text nodes and crashes React (`__root.tsx:41-49`).
12. Root providers: `QueryClientProvider`, `TooltipProvider`, `ExportToSheetsModal`, `<Toaster position="bottom-right" mobileOffset={{ bottom: 100 }} />` (`__root.tsx:107-112`).
13. Theme picker is a segmented System / Light / Dark control (`openseo:src/client/components/ThemePreferenceMenuItems.tsx:12-33`) shown in the account menu (`openseo:src/client/components/Sidebar.tsx:306-311`).

**Shell**

14. `AuthenticatedAppLayout` renders `SidebarProvider` at `h-[100dvh]`, the sidebar, and a `SidebarInset` restyled to a flat panel with a top-left radius on desktop; inside it a mobile top bar, global banners, an optional banner and a scrolling content area (`openseo:src/client/layout/AppShell.tsx:107-122`). The shell renders before the session is confirmed (`ready=false`) and loads nothing until then (`:28-31`).
15. Mobile top bar (below `md`): sidebar trigger and product name (`AppShell.tsx:140-149`).
16. The shadcn sidebar: width `15rem`, mobile drawer `15rem`, state cookie `sidebar_state` (7 days), shortcut key `b` (`openseo:src/client/components/ui/sidebar.tsx:29-34`). OpenSEO gates the Cmd/Ctrl+B handler to mobile (`sidebar.tsx:98-112`); on desktop there is no collapse control in the shell. Below 768 px (`openseo:src/client/hooks/use-mobile.ts:3`) the sidebar is a `Sheet` (`sidebar.tsx:186-209`).
17. `Sidebar` uses `variant="inset" collapsible="offcanvas"` (`openseo:src/client/components/Sidebar.tsx:141`). Header: product name link and project switcher (`:142-155`). Group labels are uppercase, tracking-wider, at 40 % foreground (`:176`). Active item: accent background plus a 3 px primary bar on the left (`:55-56`). Until a project is known, rows render without links (`placeholder`, `aria-busy` on the nav) so the sidebar keeps its shape (`:126-133`, `:170-173`). Footer: help link and an account dropdown (email, organisation switch, Settings, Billing, Theme, Sign out) (`:205-337`); while the session loads the account row is a `SidebarMenuSkeleton` (`:329-333`).
18. Navigation registry: items with `to`, `label`, `icon`, optional `activeOptions.exact`, grouped Overview / Research / AI Visibility / My Site / AI Tools (`openseo:src/client/navigation/items.ts:18-161`).
19. Project switcher: combobox showing name and domain, search only at ≥ 8 projects (`openseo:src/client/features/projects/ProjectSwitcher.tsx:23-31`), skeleton of the same box while loading (`:51-70`), a gear button to project settings (`:126-146`), "New project" and "Manage projects" at the bottom (`:174-204`). Switching keeps the current section and drops detail segments (`:72-93`). The last project is remembered in `localStorage["openseo:lastProjectId"]`, never trusted by the server (`openseo:src/client/lib/active-project.ts:1-32`).
20. Global banners are full-width `Alert banner` strips above the content (`openseo:src/client/layout/AppBanner.tsx:5-22`, `openseo:src/client/components/ui/alert.tsx:18-21`).

**Shared components** (`openseo:src/client/components/`)

21. `PageHeader` (title `text-2xl font-semibold tracking-tight`, description, actions, optional back link), `SectionHeader`, `BackLink`, `BackButton` (`PageHeader.tsx:10-102`).
22. `EmptyState` with `kind: "no-data" | "filtered" | "error"` choosing the icon (`Inbox`, `SearchX`, `CircleAlert`), `variant: "dashed" | "card" | "plain"`, `role="alert"` for errors (`EmptyState.tsx:12-73`).
23. `ErrorState` with `inline | card | page` variants and a "Try again" button (`ErrorState.tsx:18-81`).
24. `QueryState`: skeleton while pending; on a failed refetch the loaded content stays visible with the error above it (`QueryState.tsx:57-87`, tested in `QueryState.test.ts:19-42`). Out-of-credits errors render a dedicated card (`QueryState.tsx:39-41`).
25. Skeleton presets: stat grid, 8 table rows by default, card, page (`SkeletonPresets.tsx:8-104`). The page frame is `px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8` around `mx-auto max-w-7xl` (`SkeletonPresets.tsx:80-86`; same in `openseo:src/routes/_app/p/$projectId/ai-visibility.tsx:26-27`).
26. `ConfirmDialog` (cannot close while pending, `ConfirmDialog.tsx:19-61`), `InlineConfirm` (trash icon → Remove/Cancel, `InlineConfirm.tsx:10-80`), `CopyButton` (2 s check mark, `CopyButton.tsx:12-54`, `openseo:src/client/hooks/useCopy.ts:8-28`), `Markdown` with explicit element classes and http(s)-only links (`Markdown.tsx:21-125`), `Spinner`/`PageLoading` (`Spinner.tsx:5-41`), `NavTabs` (`NavTabs.tsx:6-35`), `SegmentedToggle` (`SegmentedToggle.tsx:14-59`), `HelpLabel` (`HelpLabel.tsx:11-26`), `GateCard` (`GateCard.tsx:16-81`), `StatusScreen` (`StatusScreen.tsx:16-72`), `RowActionsMenu` (`RowActionsMenu.tsx:11-31`), `CountryCombobox` (`CountryCombobox.tsx:15-68`), `LocationSelect` (`LocationSelect.tsx:22-68`), `ChartGrid`/`ChartXAxis`/`ChartYAxis` (`ChartAxes.tsx:9-37`), `CardShell` (`CardShell.tsx:15-47`), `FormDialog` (`FormDialog.tsx:15-42`), `FormActions` (`FormActions.tsx:4-31`), `PermissionHint` (`PermissionHint.tsx:4-16`), `SafeExternalLink` (`SafeExternalLink.tsx:5-25`), `ExpandableList` (first three items and "+N more", `ExpandableList.tsx:4-38`), `NotFound` (`NotFound.tsx:11-29`), `DefaultCatchBoundary` ("Try Again", "Go Back", `DefaultCatchBoundary.tsx:14-95`).
27. Primitives are shadcn base-nova files with local additions: `Button` has `pending` (spinner + disabled + `aria-busy`) and sizes `xs/sm/default/lg/icon-*` (`ui/button.tsx:6-69`); `Alert` has `info/success/warning/destructive` and a `banner` variant (`ui/alert.tsx:5-27`); `Card` has `size` (`ui/card.tsx:4-21`); `Empty` has `plain/dashed/card` (`ui/empty.tsx:4-24`); `Badge` has `soft/success/warning/info` and `size="sm"` (`ui/badge.tsx:6-38`); `Skeleton` uses a foreground tint because muted equals the page background (`ui/skeleton.tsx:3-14`); `chart.tsx` themes read `[data-theme=openseo-dark]` and colour axes from the trend tokens (`ui/chart.tsx:7`, `:68`). 31 files in total: accordion, alert-dialog, alert, badge, button, card, chart, checkbox, collapsible, combobox, dialog, dropdown-menu, empty, field, input-group, input, label, progress, radio-group, select, separator, sheet, sidebar, skeleton, spinner, switch, table, tabs, textarea, toggle-group, toggle, tooltip.
28. Auth pages: a centred column on the page background, `max-w-xs`, logo, `text-xl` title and helper text (`openseo:src/client/features/auth/AuthPage.tsx:131-175`).

## 3. What Perceev has today

- **Stack:** Next.js 15.5.27, React 18, Tailwind 3.4 with `tailwind.config.js` and `tailwindcss-animate`, PostCSS plugin `tailwindcss` (`package.json`, `postcss.config.mjs`). No `tsconfig.json` until F01 phase 1. `lucide-react` ^1.22 and `sonner` ^2.0.7 are already installed.
- **Hidden dependency:** `sucrase` 3.35.1 is installed only because Tailwind 3 depends on it (`package-lock.json`: `node_modules/tailwindcss` requires `sucrase ^3.35.0`). `src/lib/renderHarness.mjs:24` imports it for every render-harness test. Removing Tailwind 3 removes it, which would break `portalProgress`, `portalRegressions`, `tenantWorkspace`, `lightDesign`, `crawlabilityRivalOutcome` and `vendorInfraGuard`.
- **CSS:** `src/app/globals.css` (1,074 lines) holds Perceev's light tokens (`--paper: #F7F7FA`, `--brand: #3730CE`, inks, lines, status colours, rival ramp) and the public site's styles; the root layout also imports `src/components/design-system/primitives.css` and `src/components/portal/portal.css` globally (`src/app/layout.js:1-3`). It defines names that collide with shadcn: a legacy HSL block `--background` … `--radius` (lines 286-305), `--accent: var(--brand)` (149), `--info: var(--brand)` (177) and `--chart-1..5` (217-221). Of these, only `var(--accent)` is read outside `globals.css`: 26 times in 14 files under `src/components/dashboard/` and `src/components/studio/`. The HSL block is read only by `tailwind.config.js` colour entries that no source file uses (0 occurrences of `bg-background`, `text-muted-foreground`, `bg-primary` and similar) and by `@apply border-border` (line 1072).
- **Tailwind usage in source:** small. A scan for utilities renamed or changed in Tailwind 4 (`shadow`, `rounded`, `blur`, `outline-none`, `ring`, `*-opacity-*`, `flex-shrink/grow`, `[--var]`, `transform`, `translate/scale/rotate`, `space-x/y`, `container`, `theme()`) finds 0 occurrences in `src/**/*.{js,jsx}`. The public site is styled by its own CSS.
- **Theme:** one light interface. `src/app/layout.js` renders `<html lang="en" data-theme="light">` and a light `Toaster` with inline legacy styles. `DESIGN.md` forbids dark mode, theme toggles and boot scripts (`DESIGN.md:8-10`, `:50-54`).
- **Guards on the light decision:** `src/lib/lightDesign.test.mjs:8-22` (layout HTML is light, Toaster theme `light`, no `localStorage` in the layout, no dark selectors in `globals.css`, no `ThemeToggle.jsx`) and `:24-35` (primitives shared); `src/lib/docStatus.test.mjs:90-99` (exactly one design doc LIVE: `DESIGN.md`) and `:101-110` (DESIGN.md says "one light interface", layout light, `--paper: #F7F7FA`, no dark selectors in `globals.css`); `src/components/portal/portalProgress.test.mjs:160-168` (globals `:root { --paper:`, layout light, `PortalShell.jsx` sets no `data-theme`).
- **Portal shell:** `src/components/portal/PortalShell.jsx` (324 lines) boots Supabase auth, accepts invites, loads memberships, keeps one `usePortal()` context (overview, gsc, scan tracker), and renders its own sidebar (`PortalFrame`, `:248-323`): logo, a native `<select>` workspace switcher (`:266-281`), nav with live meta (scan %, drafts awaiting review, GSC dot), a "Scan running" card, user email and sign-out. Workspace choice: `?brand_key=` then `localStorage["perceev-portal-brand"]` then the first membership (`:127-133`). Self-service onboarding allows one workspace per account (`src/app/api/customer/onboard/route.js:37`).
- **Portal primitives:** `src/components/portal/ui.jsx` exports `PageHeader, Card, Stat, Button, Badge, Banner, EmptyState, ProgressBar, StageSteps, Tabs, Skeleton, SkeletonRows, Spinner, TopLoadingBar, formatDate, formatRelative, formatDuration, formatPct`. `ProgressBar` encodes the honest-number rule: unknown is a still "not measured" rail (`ui.jsx:122-167`). The public `/demo` page imports `Banner, Button, Card, PageHeader` and `MockScanPanel` from the portal (`src/app/demo/page.jsx:5-6`).
- **Pages to migrate:** `src/app/portal/{page,measurement/page,scans/page,scans/[scanId]/page,content/page,search-console/page,team/page}.jsx` and their components under `src/components/portal/{overview,scans,content,gsc,team}/`, `ScanProgressCard.jsx`; auth surfaces `src/app/{login,signup,onboarding}/page.jsx`, `src/app/auth/{accept,reset}/page.jsx` on `src/components/portal/AuthLayout.jsx` + `auth.css`. The run-scan fix (`fix/run-scan-unapproved-panel`) edits `src/app/portal/page.jsx`, `ScanProgressCard.jsx`, `overview/GettingStarted.jsx` and `useScanTracker.js`; the measurement page is restyled here, in P5.T5.
- **Tests that assert on markup** (all must keep passing or be updated with the reason stated in §8):
  1. `src/lib/lightDesign.test.mjs` — layout, Toaster, CSS files.
  2. `src/lib/docStatus.test.mjs:90-110` — design authority.
  3. `src/components/portal/portalProgress.test.mjs` — `ProgressBar` classes `pv-progress--unmeasured`, `pv-progress--indeterminate`, `pv-progress__fill`, `is-active`, `aria-*`; `StageSteps` `is-done`/`is-current`/`aria-current="step"`; `ScanProgressCard` text, `role="progressbar"`, `data-testid="portal-scan-progress"`, `pv-banner--{success|warn|error|info}`, link `/portal/scans/report-1`; layout/CSS checks.
  4. `src/components/portal/portalRegressions.test.mjs` — `ReportCards` text and progress classes; scan report page found by `node.type === ui.Banner`/`ui.Stat`/`ui.Button`, `data-testid="customer-collection-outcome"`; `DraftEditor`/`ReviewFindings` with a hand-made `ui` map; also `GettingStarted` (`buildChecklist`, including the "panel" step from the run-scan fix). The measurement page has no page test on `main`; P5.T5 adds one.
  5. `src/components/portal/tenantWorkspace.test.mjs` — Content Studio text, tab `aria-selected`, scans page text, `ComposerCard` `<option>`s, `ReviewFindings` text.
  These tests compile files with `compileJsx` (sucrase `jsx` + `imports` only) and resolve every import from an explicit map, so any new import in a compiled file must be added to that test's map.
- **Browser QA:** `scripts/qa/check-public-browser.mjs` (public inventory at 1440 and 390 px, no horizontal overflow) runs in CI's `build` job against `next start -p 3328` built with `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co` (`.github/workflows/ci.yml:154-177`). No portal browser check exists.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F04-AC-01 | `package.json` has React 19, Tailwind 4 (`@tailwindcss/postcss`), `tw-animate-css`, `@base-ui/react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `recharts` 3, `react-markdown`, `remark-gfm`, devDependencies `shadcn` and an exact `sucrase` pin; `tailwindcss-animate` is gone. `npm run build` and `npm run typecheck` exit 0. | CI `build`, `tests`; unit `src/lib/platform/f04Toolchain.test.mjs` |
| F04-AC-02 | Every public route (`getPublicUrlInventory()` plus `/scan`) at 1440×1000 and 390×844 has the same layout snapshot before and after each F04 phase, except entries in that phase's allowlist (phase 1–4: empty; phase 5: `/demo` only, because it renders portal components). | browser `scripts/qa/check-f04-public-layout.mjs` |
| F04-AC-03 | The full unit suite passes after every phase; the render harness still compiles (sucrase present). | CI `tests` |
| F04-AC-04 | App tokens: light values at `:root`, dark values only under `:root[data-theme="dark"]`; primary `#3730CE` light; every listed text/background pair has WCAG contrast ≥ 4.5 in both themes (§6.6.1). | unit `src/lib/theme/tokens.test.mjs` |
| F04-AC-05 | The theme script and `SurfaceSync` set `data-surface="app"` on app paths only (`/portal`, `/onboarding`, `/login`, `/signup`, `/auth`, `/ops`); `data-theme="dark"` only on user-theme app paths (all but `/ops`) when the preference is dark, or system with OS dark. Public paths are always `data-theme="light"` with no `data-surface`. | unit `src/lib/theme/theme.test.ts`; browser `check-f04-browser.mjs` case `F04-B03` |
| F04-AC-06 | All 31 primitives exist under `src/components/ui/` with the licence header and `"use client"`, import `cn` from `@/lib/utils`, and contain no `openseo` theme names or OpenSEO branding. | unit `src/components/ui/uiInventory.test.mjs` |
| F04-AC-07 | `QueryState` decision logic: pending → loading; error without data → error only; error with data → error above content; success → content. | unit `src/components/app/queryStateView.test.ts` |
| F04-AC-08 | Navigation model: items with a `flag` are hidden unless `features[flag] === true`; `ownerOnly` items are hidden for members; empty groups are dropped; Overview matches exactly, others by prefix plus `activePrefixes`; switching workspace keeps the deepest registry section that prefixes the current path. | unit `src/components/app/navigation/navModel.test.ts` |
| F04-AC-09 | `GET /api/customer/features?brand_key=` returns `{ brandKey, features }` for every name in `CLIENT_FEATURES`, with `Cache-Control: no-store`; 401/403/404 from `requireWorkspace`; unknown query fields → 400. | route `src/lib/features/features.route.test.mjs`; contract test (F01) |
| F04-AC-10 | Shell: desktop inset sidebar 15 rem with groups, active bar, workspace switcher and account menu; below 768 px a top bar with a trigger opens the drawer; Cmd/Ctrl+B toggles the drawer on mobile; switching workspace from `/portal/scans/<id>` lands on `/portal/scans` with the new workspace's data; theme radio changes `data-theme` immediately and persists across reload without a light flash. | browser `scripts/qa/check-f04-browser.mjs` cases `F04-B01`…`F04-B06` |
| F04-AC-11 | Every portal page and auth page renders inside the new shell or auth shell, has exactly one `h1`, has no horizontal overflow at 390 px, and no element with class `pv-app`, `pv-sidebar`, `pv-auth` or `pv-page-header` remains. | browser `check-f04-browser.mjs` case `F04-B07`; unit `src/components/portal/legacyMarkupGuard.test.mjs` |
| F04-AC-12 | `DESIGN.md` describes the two surfaces (public light-only; app light/dark per OpenSEO) and stays the only LIVE design authority; the rewritten guards in `lightDesign.test.mjs` and `docStatus.test.mjs` pass. | unit (those files) |
| F04-AC-13 | App routes carry `<meta name="google" content="notranslate">` and the app root has `translate="no"`; public routes do not. | browser `F04-B08` |
| F04-AC-14 | Native inputs without `data-slot` compute to 16 px font size inside the app; `reveal-on-hover` hides row actions until hover/focus and shows them on coarse pointers. | unit `tokens.test.mjs` (CSS text); browser `F04-B09` |
| F04-AC-15 | No source file under `src/` contains the string `OpenSEO` except licence headers (`Portions ported from every-app/open-seo`). | unit `src/lib/brandingGuard.test.mjs` |
| F04-AC-16 | The `ui.jsx` facade renders the same class lists as the F04 primitives it mirrors (button default/outline/ghost/destructive at default and sm size; card; badge variants; alert variants) and keeps its tested hooks (`pv-progress--*`, `pv-banner--*`, `is-*`, ARIA, `data-testid`). | unit `src/components/portal/uiFacadeParity.test.mjs` plus existing portal tests |

## 5. Scope

**In scope**
- Dependency upgrades and the Tailwind 4 migration with the public site unchanged.
- App tokens, dark mode, theme script, surface attribute, toaster, `DESIGN.md` rewrite and guard updates.
- All 31 primitives; the shared components listed in §6.6.3 (including `ExpandableList` and `Markdown` with `MARKDOWN_COMPONENTS`); the `DialogContent` full-screen-on-mobile option F09 needs.
- App shell, sidebar, mobile top bar, workspace switcher, account menu, global banner slot, navigation registry with flag-gated items, `/api/customer/features`, `/portal/settings` shell with its General tab, portal `not-found` and `error` pages.
- Migration of every existing portal page and auth page to the new shell and components.
- Browser harness for authenticated portal pages with fixture APIs (`scripts/qa/portalFixtureHarness.mjs`), reused by F05, F06 and later specs.

**Out of scope**
- TanStack Query client, fetch client, polling, URL state, search tabs (F05). `QueryClientProvider` is added to `AppProviders` by F05.
- Data tables, export menu, CSV/Sheets (F06). The scan report's download button keeps working until F06.
- `MarkdownAnswer` (collapsible LLM answer): F11 ships it at `src/components/app/markdown/MarkdownAnswer.tsx` on top of F04's `MARKDOWN_COMPONENTS`; F12 reuses F11's.
- `CountryCombobox`/`LocationSelect` location data: F04 ships the components with a required `options` prop; F13 supplies DataForSEO location lists.
- Behaviour of deferred "Mixed" rows: Search Console (restyle only), Teams (restyle only; no new roles, no "New workspace"), Trend comparability (the overview trend keeps its bar list; no Recharts conversion), Competitors, Citations, Stable question set, Free tools. Their logic and data are untouched.
- Billing, help/support links, organisation switching (no equivalent).
- The public marketing site's look (kept as is); `/ops/*` page content (gets tokens and providers only).
- Collapsible desktop sidebar (OpenSEO has none), column/density controls.

## 6. Design

### 6.1 Data model

None. Migrations 055–059 stay unused.

### 6.2 Server modules

#### `src/lib/features/clientFeatures.ts` (new)

```ts
import type { FeatureName } from "./names.ts";
/** Flags whose on/off state the browser may read (sidebar items, optional UI). Each spec appends its own names. */
export const CLIENT_FEATURES: readonly FeatureName[] = [];
export async function readClientFeatures(brandKey: string,
  deps?: { isEnabled?: (name: FeatureName, brandKey: string) => Promise<boolean> }): Promise<Record<string, boolean>>;
// Evaluates every CLIENT_FEATURES name with isFeatureEnabled (F01) in parallel. A rejected evaluation counts as false.
```

#### `src/lib/features/features.contract.ts` (new)

```ts
import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
export const featuresQuery = z.strictObject({ brand_key: z.string().min(1).max(120) });
export const featuresResponse = z.looseObject({ brandKey: z.string(), features: z.record(z.string(), z.boolean()) });
export const contracts = [defineRouteContract({
  id: "customer.features.get", method: "GET", path: "/api/customer/features",
  file: "src/app/api/customer/features/route.ts", auth: "workspace",
  query: featuresQuery, response: featuresResponse,
  errorCodes: ["invalid_request", "auth_not_configured", "unauthenticated", "membership_unavailable", "workspace_not_found", "storage_unavailable", "internal_error"],
  examples: [{ response: { brandKey: "acme", features: { usage_page: true, price_review: false } } }],
})];
```

(The codes are the ones F01's `requireWorkspace` and `toErrorResponse` emit, F01 §6.2 / F01-AC-05.)

#### `src/lib/theme/theme.ts` (new, pure, node-testable; relative imports only)

```ts
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "perceev:theme-preference";
export const THEME_CHANGE_EVENT = "perceev:theme-preference-change";
export const APP_SURFACES = [
  { prefix: "/portal", theme: "user" }, { prefix: "/onboarding", theme: "user" },
  { prefix: "/login", theme: "user" }, { prefix: "/signup", theme: "user" },
  { prefix: "/auth", theme: "user" }, { prefix: "/ops", theme: "light" },
] as const;   // later specs append (F23 adds "/r")
export function surfaceForPath(pathname: string): { surface: "app" | "site"; themeMode: "user" | "light" };
// match: pathname === prefix || pathname.startsWith(prefix + "/"); no match → { surface: "site", themeMode: "light" }
export function parsePreference(raw: string | null): ThemePreference;   // "light" | "dark" → itself; else "system"
export function resolveTheme(pref: ThemePreference, prefersDark: boolean, mode: "user" | "light"): ResolvedTheme;
// mode "light" → "light"; "light"/"dark" → itself; "system" → prefersDark ? "dark" : "light"
export function buildThemeInitScript(): string;
// An IIFE string embedding APP_SURFACES and THEME_STORAGE_KEY via JSON.stringify. It reads location.pathname,
// localStorage, matchMedia("(prefers-color-scheme: dark)"); sets documentElement data-theme ("light"|"dark") and
// sets data-surface="app" or removes it. Any exception → data-theme="light" and no data-surface. (PORT of openseo:src/client/lib/theme.ts:131-142.)
```

#### `src/app/api/customer/features/route.ts` (new) — §6.5.

### 6.3 Jobs

None.

### 6.4 Provider calls and cost

None.

### 6.5 API routes

**`GET /api/customer/features?brand_key=<key>`**

- Auth: `requireWorkspace(request, { brandKey })` (member or owner).
- Query: `featuresQuery` (strict; unknown keys → 400 `invalid_request`).
- Response 200:
  ```json
  { "brandKey": "acme", "features": { "usage_page": true, "price_review": false } }
  ```
  With an empty `CLIENT_FEATURES`, `features` is `{}`.
- Errors via `toErrorResponse`: 400 `invalid_request`; 401 `unauthenticated`; 404 `workspace_not_found` (not a member, or unknown key); 503 `auth_not_configured` / `membership_unavailable` / `storage_unavailable`; 500 `internal_error`.
- Headers: `Cache-Control: no-store`. No idempotency concerns (read-only). No polling; the client caches it for 5 minutes (F05 default) and refetches on window focus.

### 6.6 UI

#### 6.6.1 Tokens (`src/styles/app-theme.css`, imported by `src/app/globals.css`)

Single Tailwind entry: `src/app/globals.css` begins with

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "../styles/app-theme.css";
@config "../../tailwind.config.js";
```

`app-theme.css` content (PORT of `openseo:src/client/styles/app.css`, theme names renamed `openseo` → `light`, `openseo-dark` → `dark`):

1. `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`
2. `@theme { --container-8xl: 88rem; }` and `@theme inline { … }` copied from `app.css:14-62`, plus `--color-chart-you: var(--chart-you); --color-chart-rival-1: var(--chart-rival-1); --color-chart-rival-2: var(--chart-rival-2); --color-chart-rival-3: var(--chart-rival-3); --color-chart-none: var(--chart-none);`.
3. `:root { … }` light tokens = `app.css:64-105` with these Perceev changes: `--primary: #3730ce; --ring: #3730ce; --sidebar-primary: #3730ce; --sidebar-ring: #3730ce; --destructive: #b02f2f;` (Perceev `--crit`, AA as text; OpenSEO's `oklch(65% 0.2 25)` is 3.6:1 on white), and additions `--chart-you: var(--primary); --chart-rival-1: #8a90a6; --chart-rival-2: #b4b9c9; --chart-rival-3: #d3d6e0; --chart-none: #e5e7ef;`, the trend tokens of `app.css:148-156`, and `--app-font-sans: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; --app-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;`.
4. `:root[data-theme="dark"] { … }` = `app.css:107-146` and `:343-351` with `--primary: #8c87f7; --primary-foreground: #0e1017; --ring: #8c87f7; --sidebar-primary: #8c87f7; --sidebar-primary-foreground: #0e1017; --sidebar-ring: #8c87f7;` (white on a primary light enough to read on dark cards fails AA, so the text on primary is Perceev ink), `--chart-rival-1: oklch(70% 0.01 260); --chart-rival-2: oklch(55% 0.01 260); --chart-rival-3: oklch(42% 0.01 260); --chart-none: oklch(32% 0 0);`, and the **legacy bridge** so legacy-styled code inside the app follows dark mode: `--paper: var(--background); --surface: var(--card); --sunken: var(--muted); --raised: var(--popover); --ink-1: var(--foreground); --ink-2: color-mix(in oklch, var(--foreground) 78%, transparent); --ink-3: color-mix(in oklch, var(--foreground) 68%, transparent); --ink-4: color-mix(in oklch, var(--foreground) 60%, transparent); --line: var(--border); --line-soft: color-mix(in oklch, var(--border) 60%, var(--background)); --line-strong: var(--input); --brand: var(--primary); --brand-lift: #a6a2fa; --brand-tint: color-mix(in oklch, var(--primary) 18%, transparent); --brand-line: color-mix(in oklch, var(--primary) 40%, transparent); --on-brand: var(--primary-foreground); --good: oklch(72% 0.15 155); --good-tint: color-mix(in oklch, oklch(72% 0.15 155) 18%, transparent); --warn: oklch(80% 0.15 80); --warn-tint: color-mix(in oklch, oklch(80% 0.15 80) 18%, transparent); --crit: oklch(70% 0.17 25); --crit-tint: color-mix(in oklch, oklch(70% 0.17 25) 18%, transparent); --you: var(--primary); --rival-1: var(--chart-rival-1); --rival-2: var(--chart-rival-2); --rival-3: var(--chart-rival-3); --none: var(--chart-none);`. Dark mode is only ever set on app paths, so the bridge never reaches the public site.
5. App-surface rules: `:root[data-surface="app"] { --font-sans: var(--app-font-sans); --font-mono: var(--app-font-mono); }` (OpenSEO uses Tailwind's default stacks; the Perceev logo keeps Archivo explicitly); `[data-surface="app"] body { background: var(--background); color: var(--foreground); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }`; `html:has([data-slot="sidebar-wrapper"]), html:has([data-slot="sidebar-wrapper"]) body { height: 100%; overflow: hidden; }` (OpenSEO `app.css:158-165`, scoped to the shell so `/ops` and auth pages still scroll); scrollbar colour (`app.css:167-171`) on `html[data-surface="app"]`; touch rules (`app.css:196-204`) on `html[data-surface="app"]`.
6. Outside any layer (so it beats utilities, as in `app.css:177-181`): `[data-surface="app"] input:not([data-slot]), [data-surface="app"] textarea:not([data-slot]), [data-surface="app"] select:not([data-slot]) { font-size: 1rem; line-height: 1.5rem; }`.
7. Base layer: `@layer base { *, ::after, ::before, ::backdrop, ::file-selector-button { border-color: hsl(233 18% 90%); } [data-surface="app"] *, [data-surface="app"] ::after, [data-surface="app"] ::before, [data-surface="app"] ::backdrop { border-color: var(--border); outline-color: color-mix(in oklab, var(--ring) 50%, transparent); } button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; } }` — the first rule keeps the public default border colour exactly (it is the value the removed legacy `--border` triplet produced through `@apply border-border`); the cursor rule restores Tailwind 3's pointer cursor that Tailwind 4 preflight dropped (already added in phase 1).
8. `@utility reveal-on-hover { @apply opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100; }` and `@utility pb-safe { padding-bottom: calc(env(safe-area-inset-bottom, 0.5rem) + 0.5rem); }`.
9. Tag chips and score tiers copied from `app.css:206-341`, selector `html[data-theme="openseo-dark"]` → `html[data-theme="dark"]`.

**Contrast pairs** (checked by `tokens.test.mjs`, ≥ 4.5:1, both themes; alpha colours are composited over the background in sRGB-encoded space): foreground/background, foreground/card, muted-foreground/card, muted-foreground/background, primary-foreground/primary, primary/card (links), sidebar-foreground/sidebar, `color-mix(sidebar-foreground 65%)`/sidebar (group labels, see deviation 3), destructive/card. Expected values: light foreground/background ≈ 15.9, muted-foreground/card ≈ 4.7, muted-foreground/background ≈ 4.5, primary-foreground/primary ≈ 8.6, destructive/card ≈ 6.4; dark primary-foreground/primary ≈ 6.2, primary/card ≈ 5.0. If muted-foreground/background computes below 4.5, change the light `--muted-foreground` alpha from `60%` to `64%` (one constant, recorded in the PR).

#### 6.6.2 Primitives (`src/components/ui/`)

COPY of all 31 `openseo:src/client/components/ui/*.tsx` files. Per file: licence header (conventions §2), `"use client";` as the first line, `import { cn } from "cn"` → `import { cn } from "@/lib/utils"`, `@/client/components/ui/*` → `@/components/ui/*`, `@/client/hooks/use-mobile` → `@/components/app/hooks/use-mobile`. `chart.tsx`: `THEMES = { light: "", dark: "[data-theme=dark]" }`. Two Perceev additions:

- `dialog.tsx` `DialogContent` gains `fullScreenOnMobile?: boolean` (default `false`). When true, below 640 px the content is full-screen: classes `max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:pb-safe`; `DialogFooter` stacks buttons with the primary first (`flex-col` instead of `flex-col-reverse`) under the same flag via `data-fullscreen`. F09 uses this for the cost dialog.
- `sidebar.tsx` is unchanged (keeps the mobile-only shortcut, deviation 4).

`src/lib/utils.ts`: `import { clsx, type ClassValue } from "clsx"; import { twMerge } from "tailwind-merge"; export function cn(...inputs: ClassValue[]): string { return twMerge(clsx(inputs)); }` (deviation 2).

`components.json` (repo root, for future `shadcn` CLI use): `{"$schema":"https://ui.shadcn.com/schema.json","style":"base-nova","rsc":true,"tsx":true,"tailwind":{"config":"","css":"src/app/globals.css","baseColor":"neutral","cssVariables":true,"prefix":""},"iconLibrary":"lucide","rtl":false,"aliases":{"components":"@/components","utils":"@/lib/utils","ui":"@/components/ui","lib":"@/lib","hooks":"@/components/app/hooks"},"menuColor":"default","menuAccent":"subtle","registries":{}}`.

#### 6.6.3 Shared app components (`src/components/app/`)

All TSX, `"use client"`, licence header where COPY/PORT. Router adaptations: TanStack `Link`/`createLink` → `next/link`; `useLocation` → `usePathname`.

| File | Exports and Perceev adaptation |
|---|---|
| `PageHeader.tsx` | `PageHeader({ title, description?, actions?, backLink? })`, `SectionHeader`, `BackLink({ href, children })` (Next `Link` + `ChevronLeft`), `BackButton`. COPY with the Next link. |
| `PageFrame.tsx` | `PageFrame({ children, width?: "7xl" \| "full" })` → `<div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8"><div className="mx-auto max-w-7xl space-y-5">` (`full` drops `max-w-7xl`). |
| `EmptyState.tsx` | COPY. |
| `ErrorState.tsx` | COPY. |
| `queryStateView.ts` | Pure: `queryStateView(q: { isPending: boolean; isError: boolean; fetchStatus?: "fetching" \| "paused" \| "idle"; data: unknown }): "loading" \| "idle" \| "error" \| "error+content" \| "content"` (pending with `fetchStatus: "idle"` is a disabled query → `"idle"`, rendered by `QueryState`'s `idle` prop, default nothing). Relative imports only. |
| `QueryState.tsx` | `QueryError({ error?, cause?, fallback, onRetry?, isRetrying?, variant?, title? })` and `QueryState({ query, errorFallback, loading?, children })` using `queryStateView`. `describeError(error, fallback)` from `./errors/describeError.ts` (F04 version: `error instanceof Error && error.message ? error.message : fallback`). F05 replaces `describeError` and adds the `SpendRefusedError` branch in place of OpenSEO's `InsufficientCreditsError` (`QueryState.tsx:39-41`). `UseQueryResult` is a type-only import from `@tanstack/react-query` (installed in phase 1). |
| `SkeletonPresets.tsx` | `SkeletonStatGrid`, `SkeletonTableRows` (default 8 rows), `SkeletonCard`, `SkeletonPage`, `SkeletonPageContent`. COPY. |
| `ConfirmDialog.tsx`, `InlineConfirm.tsx`, `CopyButton.tsx` (+ `hooks/useCopy.ts`), `Spinner.tsx` (`Spinner`, `PageLoading`), `SegmentedToggle.tsx`, `HelpLabel.tsx`, `GateCard.tsx`, `RowActionsMenu.tsx`, `ChartAxes.tsx`, `CardShell.tsx`, `FormDialog.tsx`, `FormActions.tsx`, `SafeExternalLink.tsx`, `ExpandableList.tsx` | COPY. |
| `NavTabs.tsx` | `NavTabs({ label, children })`, `NavTab({ href, exact?, children })`: Next `Link`; active when `exact ? pathname === href : pathname === href \|\| pathname.startsWith(href + "/")`; sets `data-status="active"` and `aria-current="page"`. PORT. |
| `Markdown.tsx` | `Markdown({ children, className? })` and `MARKDOWN_COMPONENTS` (F11's `MarkdownAnswer` imports it). COPY; `safeHttpUrl` from `@/shared/safe-url`. |
| `StatusScreen.tsx` | COPY; `logo` renders `<PerceevMark className="size-10" />` instead of OpenSEO's image. |
| `PermissionHint.tsx` | PORT; copy "Ask a workspace owner to {action}." (no organisations). |
| `CountryCombobox.tsx`, `LocationSelect.tsx` | PORT; `options: readonly LocationOption[]` is **required** (no default list); `export type LocationOption = { code: number; label: string; shortLabel: string }`. |
| `AppBanner.tsx` | COPY of `openseo:src/client/layout/AppBanner.tsx`. |
| `NotFound.tsx` | PORT: title "404", body "The page you are looking for does not exist.", button "Back to overview" → `/portal`. |
| `ErrorBoundaryCard.tsx` | PORT of `DefaultCatchBoundary.tsx:39-82`: message always "Something went wrong. Please try again." (the error is logged to the console and shown as a muted detail line only outside production), buttons "Try again" (calls `reset`) and "Go back" (`history.back()`). |
| `brand/PerceevLogo.tsx` | `PerceevMark({ className? })`: 22 px square, radius 7 px, `linear-gradient(135deg, var(--brand), var(--brand-lift))`, inset white ring (from `portal.css:63-69`). `PerceevLogo({ size?: "sm" \| "md" })`: mark + wordmark "perceev", `font-family: 'Archivo', system-ui, sans-serif`, weight 750, letter-spacing −0.05em, 18 px (`md`) or 16 px (`sm`). |
| `hooks/use-mobile.ts` | COPY (`MOBILE_BREAKPOINT = 768`). |
| `theme/useThemePreference.ts` | PORT of `theme.ts:16-129` using `src/lib/theme/theme.ts`; applies the theme only when `surfaceForPath(location.pathname).themeMode === "user"`. |
| `theme/ThemePreferenceRadio.tsx` | PORT of `ThemePreferenceMenuItems.tsx:12-56` (`ThemePreferenceRadio`, `ThemePreferenceDropdownItems`), labels "System", "Light", "Dark". |
| `theme/SurfaceSync.tsx` | Client component rendered once in the root layout: on every `usePathname()` change applies `surfaceForPath` + `resolveTheme` to `document.documentElement` (keeps the attributes right after client navigation between public and app pages). |
| `AppToaster.tsx` | Sonner `Toaster`, `position="bottom-right"`, `mobileOffset={{ bottom: 100 }}`; on site surfaces `theme="light"` and the existing legacy `toastOptions.style` object from `src/app/layout.js:20-30`; on app surfaces `theme` = resolved theme and no custom style. |
| `providers/AppProviders.tsx` | `AppProviders({ children })` → `TooltipProvider` (F05 wraps it in `QueryClientProvider`; F06 adds `ExportToSheetsModal`). |
| `navigation/navModel.ts`, `navigation/items.ts` | §6.6.5. |
| `shell/AppShell.tsx`, `shell/AppSidebar.tsx`, `shell/WorkspaceSwitcher.tsx`, `shell/MobileTopBar.tsx`, `shell/AccountMenu.tsx`, `shell/ScanRunningCard.tsx` | §6.6.4. |

`src/shared/safe-url.ts`: COPY of `openseo:src/shared/safe-url.ts`. F02 phase 1 also copies it; whichever PR lands second leaves the existing identical file unchanged.

#### 6.6.4 App shell

`src/app/portal/layout.jsx`:

```jsx
import { AppProviders } from "@/components/app/providers/AppProviders";
import PortalShell from "@/components/portal/PortalShell";
export const dynamic = "force-dynamic";
export const metadata = { other: { google: "notranslate" } };
export default function PortalLayout({ children }) {
  return <AppProviders><PortalShell>{children}</PortalShell></AppProviders>;
}
```

(the `import "@/components/portal/portal.css"` line moves to `PortalShell.jsx`).

`PortalShell.jsx` keeps its boot logic and the `usePortal()` value unchanged (F05 later moves overview/gsc onto queries) and replaces `PortalFrame` with:

```jsx
<AppShell ready={phase === "ready"} banner={<WorkspaceBanners />}>
  <PageFrame>{children}</PageFrame>
</AppShell>
```

`AppShell({ ready, banner, children })` (PORT of `AppShell.tsx:21-138`): `SidebarProvider className="h-[100dvh] min-h-0 overflow-hidden"`, `<AppSidebar ready />`, `SidebarInset className="min-h-0 overflow-hidden md:!m-0 md:!mt-2 md:!rounded-none md:!rounded-tl-lg md:border-l md:border-t md:border-sidebar-border md:!shadow-none" translate="no"`, then `<MobileTopBar />`, `{banner}`, `<div className="min-h-0 flex-1 overflow-auto" id="app-content">{children}</div>`. No DataForSEO key modal or GSC re-engagement modal (no equivalent).

**States**

| State | Sidebar | Content |
|---|---|---|
| Booting (`phase === "loading"`) | Logo; switcher skeleton (box with `Skeleton h-3.5 w-28` and `Skeleton h-3 w-20`, gear slot `w-12 border-l`), `aria-busy`; nav rows rendered as placeholders (`aria-disabled`, no links) with `nav aria-busy="true"`; account row `SidebarMenuSkeleton showIcon` | `SkeletonPageContent` inside `PageFrame` |
| Boot error (`phase === "error"`) | not rendered | `StatusScreen logo title="Workspace unavailable" description={bootError}` with buttons "Retry" (reloads) and "Sign out" (ghost) |
| No workspaces | not rendered | `StatusScreen logo title="Your account is ready" description="Finish setting up your workspace to start tracking how AI engines talk about your brand."` with "Set up my workspace" → `/onboarding` and "Sign out" (ghost) |
| Ready | full sidebar | page |

(Existing copy for both error states is kept from `PortalShell.jsx:222-237`.)

**`AppSidebar`** (PORT of `Sidebar.tsx:115-203`): `Sidebar variant="inset" collapsible="offcanvas" className="md:!p-0"`.
- Header (`gap-0 px-3 pb-1 pt-3`): `<Link href="/portal" className="px-1 pb-2"><PerceevLogo size="md" /></Link>`, then `WorkspaceSwitcher`. Each link calls `setOpenMobile(false)`.
- Content: `<nav aria-label="Main navigation">`; per visible group a `SidebarGroup className="py-1"`, label (when not null) `SidebarGroupLabel className="h-7 uppercase tracking-wider text-sidebar-foreground/65"`, `SidebarMenu`, one `SidebarNavLink` per item with OpenSEO's `navButtonClass` (`Sidebar.tsx:55-56`). Active item gets `aria-current="page"`.
- Live badges (`SidebarMenuBadge`, Perceev additions kept from `PortalShell.jsx:252-257`): Scans → while `scan.active`, a 12 px `Spinner` and "{n}%" (blank when unknown); Content Studio → drafts awaiting approval count when > 0; Search Console → a 6 px dot (`bg-success` connected, `bg-muted-foreground/40` not) with sr-only text "Connected" / "Not connected".
- `ScanRunningCard` above the footer when `scan.active` and the path is not `/portal` and does not start with `/portal/scans`: `Link href="/portal/scans"` styled `Card size="sm"`: line 1 "Scan running" and "{percent}%" or "—"; `Progress` (indeterminate when unknown: `ProgressIndicator` with `animate-pulse w-1/3`); line 3 "{stage label or 'Starting'}…".
- Footer: `AccountMenu` (PORT of `Sidebar.tsx:205-337` without help, organisation and billing): trigger `SidebarMenuButton aria-label="Open account menu"` with `User` icon and the email (`truncate`); content `side="top" className="w-56"`: item "Workspace settings" (`Settings` icon → `/portal/settings`), group label "Theme" with `ThemePreferenceRadio`, separator, item "Sign out" (`variant="destructive"`, `LogOut` icon) → `signOut()`. While `ready` is false: `SidebarMenuSkeleton showIcon`.

**`WorkspaceSwitcher`** (PORT of `ProjectSwitcher.tsx:33-217`):
- Data: `brands` from `usePortal()`. Loading: same skeleton box as OpenSEO (`:51-70`).
- Trigger `aria-label="Switch workspace"`: line 1 `display_name` (`text-sm font-medium`), line 2 website host (`text-xs text-muted-foreground`; `brand.website` without scheme and trailing slash), else the role ("owner" / "member").
- Gear button `aria-label="Workspace settings" title="Workspace settings"` → `/portal/settings`.
- Popup (`ComboboxContent className="w-(--anchor-width)"`): with ≥ 8 workspaces an input placeholder "Find workspace…" `aria-label="Filter workspaces"` filtering on name or host; empty text "No workspaces match."; list of items (name + host). No "New workspace" / "Manage" buttons (one workspace per self-service account; Teams is a deferred Mixed row).
- With exactly one workspace the trigger still opens the list (one item), as OpenSEO.
- Selecting: close popup and drawer; if it is the active one, nothing else. Otherwise `setBrandKey(key)` (stores `perceev-portal-brand`, as today) and `router.push(sectionPathForSwitch(NAV_GROUPS, pathname))` when that differs from `pathname`.

**`MobileTopBar`** (PORT of `AppShell.tsx:140-149`): `flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5 md:hidden`; `SidebarTrigger aria-label="Toggle sidebar"`; `<Link href="/portal" className="ml-1"><PerceevLogo size="sm" /></Link>`.

**`WorkspaceBanners`** (in `PortalShell.jsx`): when `overviewError` is set and `pathname !== "/portal"` (Overview shows its own error), `AppBanner variant="warning"` with `AlertTriangle` icon: "Workspace data could not be refreshed. {overviewError}" and a `Button size="xs" variant="outline"` "Try again" → `refreshOverview()`. Otherwise nothing.

**Keyboard and focus:** Cmd/Ctrl+B toggles the mobile drawer (below 768 px); the drawer traps focus (Sheet); Escape closes it; every nav link is reachable by Tab in DOM order; the switcher and account menu are Base UI comboboxes/menus with arrow-key navigation.

**Phone layout (< 768 px):** sidebar hidden; top bar 40 px; drawer 15 rem from the left with the same content; page frame `px-4 py-4 pb-24`; no horizontal page scroll (wide content scrolls inside its own container).

#### 6.6.5 Navigation registry

`src/components/app/navigation/navModel.ts` (pure; relative imports; no icons):

```ts
export type NavItem = {
  id: string; label: string; href: string;
  match?: "exact" | "prefix";             // default "prefix"
  activePrefixes?: readonly string[];     // extra paths that light this item
  flag?: string;                          // a CLIENT_FEATURES name; hidden unless features[flag] === true
  ownerOnly?: boolean;
  badge?: "scan" | "content" | "gsc";
  icon?: unknown;                         // set by items.ts
};
export type NavGroup = { id: string; label: string | null; items: readonly NavItem[] };
export function visibleNavGroups(groups: readonly NavGroup[], ctx: { features: Record<string, boolean> | undefined; isOwner: boolean }): NavGroup[];
export function isItemActive(item: NavItem, pathname: string): boolean;
export function activeNavItemId(groups: readonly NavGroup[], pathname: string): string | null; // longest matching href wins
export function sectionPathForSwitch(groups: readonly NavGroup[], pathname: string): string;    // longest item href that is a prefix of pathname, else "/portal"
```

`src/components/app/navigation/items.ts` (lucide icons; the only file other specs edit to add entries; group order follows conventions §12):

| Group id / label | Item id | Label | Href | Icon | Options |
|---|---|---|---|---|---|
| `top` / null | `overview` | Overview | `/portal` | `LayoutDashboard` | `match: "exact"` |
| `ai` / "AI Visibility" | `questions` | Questions | `/portal/measurement` | `MessageSquareText` | `activePrefixes: ["/portal/questions"]` |
| `ai` | `scans` | Scans | `/portal/scans` | `Radar` | `badge: "scan"` |
| `research` / "Research" | — | (F13, F14, F16, F17 add) | | | |
| `site` / "My Site" | `search-console` | Search Console | `/portal/search-console` | `Search` | `badge: "gsc"` |
| `content` / "Content" | `content` | Content Studio | `/portal/content` | `PenLine` | `badge: "content"` |
| `tools` / "AI Tools" | — | (F07, F22, F23 add) | | | |
| `settings` / "Settings" | `team` | Team | `/portal/team` | `Users` | `ownerOnly: true` (as today) |
| `settings` | `workspace-settings` | Workspace settings | `/portal/settings` | `Settings` | |

Entries other specs add (for their PRs, not F04's): F03 `usage` → "Usage", `/portal/usage`, `Gauge`, group `settings`, `flag: "usage_page"` (F03 appends `"usage_page"` to `CLIENT_FEATURES`); F11 `explore` → `/portal/explore` in `ai`; F13 keywords/saved keywords; F14 domain; F15 rank tracking; F16 backlinks; F17 local; F18 audit; F20 analytics; F22 assistant; F23 reports; F07 context. Each with its own `flag`. `/ops/costs` (F03) and every `/ops/*` page are **not** in the customer registry; they render outside the customer shell (app tokens, light theme, `AppProviders`, no sidebar). `/portal/questions/[questionId]` (F12) is not an item; it lights "Questions" through `activePrefixes`.

#### 6.6.6 `/portal/settings`

- `src/app/portal/settings/layout.tsx`: `PageHeader title="Workspace settings" description="Settings for {brand.display_name}."` then `NavTabs label="Workspace settings sections"` from `src/components/portal/settings/tabs.ts` (`SETTINGS_TABS: { href: string; label: string; exact?: boolean; flag?: string; ownerOnly?: boolean }[] = [{ href: "/portal/settings", label: "General", exact: true }]`; F10/F19/F20 append), then `{children}` (`space-y-8`, OpenSEO `settings.tsx:13-27`).
- `src/app/portal/settings/page.tsx` (General): `CardShell title="Workspace"` with a `dl`: "Name" → `display_name`, "Website" → `SafeExternalLink` of `website`, "Your role" → "Owner"/"Member"; then `PermissionHint action="change the workspace name or website"`. `CardShell title="Appearance"`: label "Theme" and `ThemePreferenceRadio` with `showLabels`; helper text "Applies to this browser. The public website is always light."

#### 6.6.7 Auth shell

`src/components/portal/AuthLayout.jsx` keeps its props (`eyebrow, title, titleId, subtitle, children, footer`) and is re-implemented on OpenSEO's `AuthPageShell` + `AuthPageCard` (`AuthPage.tsx:131-175`): `div.flex.h-[100dvh].flex-col.items-center.overflow-y-auto.bg-background.p-4` → `div.m-auto.flex.w-full.flex-col.items-center` → card column `w-full max-w-xs space-y-6`: centred `Link href="/"` with `PerceevMark className="mx-auto size-10"` (`aria-label="Perceev home"`), eyebrow (`text-xs text-muted-foreground`), `h1 id={titleId} className="text-xl font-semibold"`, subtitle (`mt-1 text-sm text-muted-foreground`), children (`space-y-4`), footer (`text-center text-sm text-muted-foreground`), then legal line "© Perceev · Privacy · Terms" (`text-xs text-muted-foreground`, links `/privacy`, `/terms`). The split-screen showcase panel is removed (deviation 6). Layout files `src/app/{login,signup,onboarding}/layout.jsx` and `src/app/auth/layout.jsx` wrap children in `AppProviders` and export `metadata = { other: { google: "notranslate" } }`. Form controls: `Field`/`FieldLabel`/`Input` with OpenSEO's `authInputClassName = "border-foreground/20 bg-card text-base md:text-base"`, submit `Button className="w-full …"` with `authSubmitClassName` (`AuthPage.tsx:16-19`), messages as `Alert variant="info"` (`role="status"` kept). All existing copy, validation, redirects and Supabase calls are unchanged.

#### 6.6.8 Page migration rules

1. Existing portal and auth files stay `.jsx` (conventions §3); they may import F04 TSX components.
2. Files compiled by the render-harness tests (`ui.jsx`, `ScanProgressCard.jsx`, `useScanTracker.js`, `scans/ReportCards.jsx`, `scans/MockScanPanel.jsx`, `content/{ContentStudio,ComposerCard,DraftEditor,ReviewFindings}.jsx`, `overview/GettingStarted.jsx`, `app/portal/scans/page.jsx`, `app/portal/scans/[scanId]/page.jsx`, `app/portal/measurement/page.jsx`) keep using the `@/components/portal/ui` facade for every element a test finds by type (`PageHeader`, `Card`, `Banner`, `Button`, `Badge`, `Stat`, `ProgressBar`, `StageSteps`, `Tabs`, `SkeletonRows`). New TSX imports in these files are added to the tests' maps as `autoNull`/`autoStub` entries (listed per subtask).
3. Never remove a class name, `data-testid`, `role` or ARIA attribute a test asserts; append utilities instead.
4. The `ui.jsx` facade keeps every export name, prop and DOM contract; its class strings are the F04 primitives' class lists (copied, guarded by `uiFacadeParity.test.mjs`); it imports nothing new except `cx` already local; `Button` maps `variant` primary→default, secondary→outline, ghost→ghost, danger→destructive and `size` md→default, sm→sm; `Badge` maps tone neutral→secondary, brand→soft, good→success, warn→warning, crit→destructive; `Banner` renders the `Alert` markup with variant info→info, success→success, warn→warning, error→destructive and keeps the class `pv-banner pv-banner--{tone}` and `role`; `Stat` renders `rounded-lg border border-border bg-card p-4` with label `text-xs text-muted-foreground`, value `text-2xl font-semibold tabular-nums` (blank → "—"); `ProgressBar` renders the `ProgressTrack`/`ProgressIndicator` classes and keeps its classes, `scaleX` fill and ARIA; `Skeleton` uses `animate-pulse rounded-md bg-foreground/10`; `Tabs` uses the `TabsList variant="line"` classes; `EmptyState` uses the `Empty` dashed classes.
5. Layout helper classes (`pv-stack`, `pv-grid`, `pv-grid--4`, `pv-row`, `pv-muted`, `pv-list*`, `pv-center`) are replaced in each page by Tailwind equivalents: `pv-stack` → `space-y-5`; `pv-grid pv-grid--4` → `grid grid-cols-2 gap-3 lg:grid-cols-4`; `pv-grid` (two columns) → `grid gap-5 lg:grid-cols-2`; `pv-row` → `flex flex-wrap items-center gap-2`; `pv-muted` → `text-muted-foreground`; list rows → `divide-y divide-border` with rows `flex items-center justify-between gap-3 px-4 py-3`.
6. Feature CSS files shrink to rules that cannot be utilities and are deleted when empty.
7. No page changes its data fetching, copy, numbers or behaviour in F04 (F05 owns fetching).

### 6.7 Permissions, privacy, observability

- `/api/customer/features` exposes only on/off states of names in `CLIENT_FEATURES` for a workspace the caller belongs to.
- Theme preference and the remembered workspace are per-browser `localStorage`; neither is sent to the server.
- No new logs. No PostHog events (F26 may add `ui:theme_changed { theme }` later; not in F04).
- Never log user emails or workspace names from the shell.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/client/styles/app.css` | `src/styles/app-theme.css` | PORT | Theme names `light`/`dark`; Perceev primary and destructive; rival/you chart tokens; legacy bridge in dark; app-only rules scoped to `data-surface="app"`; `@layer utilities` → `@utility`. |
| `openseo:components.json` | `components.json` | PORT | `rsc: true`, our aliases. |
| `openseo:src/client/components/ui/*.tsx` (31 files) | `src/components/ui/*.tsx` | COPY | `"use client"`, `cn` from `@/lib/utils`, alias paths, chart dark selector; `DialogContent fullScreenOnMobile`. |
| `openseo:src/client/hooks/use-mobile.ts` | `src/components/app/hooks/use-mobile.ts` | COPY | — |
| `openseo:src/client/lib/theme.ts` | `src/lib/theme/theme.ts`, `src/components/app/theme/useThemePreference.ts` | PORT | Split pure logic from the hook; storage key `perceev:theme-preference`; path-aware surfaces. |
| `openseo:src/routes/__root.tsx:41-49,98-112` | `src/app/layout.js`, `src/app/portal/layout.jsx`, auth layouts, `AppToaster.tsx`, `AppProviders.tsx` | PORT | Next metadata `other.google`; `translate="no"` on the app root only; init script in root `<head>`. |
| `openseo:src/client/components/ThemePreferenceMenuItems.tsx` | `src/components/app/theme/ThemePreferenceRadio.tsx` | COPY | — |
| `openseo:src/client/layout/AppShell.tsx` | `src/components/app/shell/AppShell.tsx`, `MobileTopBar.tsx` | PORT | Projects → workspaces from `usePortal()`; DataForSEO and GSC modals dropped; Perceev logo. |
| `openseo:src/client/layout/AppBanner.tsx` | `src/components/app/AppBanner.tsx` | COPY | — |
| `openseo:src/client/layout/AppShellParts.tsx` | `PortalShell.jsx` `WorkspaceBanners` | PATTERN | Banner slot only; our banner is the overview error. |
| `openseo:src/client/components/Sidebar.tsx` | `src/components/app/shell/AppSidebar.tsx`, `AccountMenu.tsx` | PORT | Registry-driven groups with flags; live badges; scan card; no help/billing/org; group label at 65 %. |
| `openseo:src/client/navigation/items.ts` | `src/components/app/navigation/items.ts`, `navModel.ts` | PORT | Static hrefs (workspace is context, not URL); `flag`, `ownerOnly`, `badge`, `activePrefixes`. |
| `openseo:src/client/features/projects/ProjectSwitcher.tsx` | `src/components/app/shell/WorkspaceSwitcher.tsx` | PORT | No create/manage; section-preserving switch via `sectionPathForSwitch`. |
| `openseo:src/client/lib/active-project.ts` | (existing `perceev-portal-brand` key in `PortalShell.jsx`) | PATTERN | Key kept; never trusted by the server. |
| `openseo:src/client/components/{PageHeader,EmptyState,ErrorState,SkeletonPresets,ConfirmDialog,InlineConfirm,CopyButton,Spinner,SegmentedToggle,HelpLabel,GateCard,RowActionsMenu,ChartAxes,CardShell,FormDialog,FormActions,SafeExternalLink,ExpandableList,Markdown}.tsx` | `src/components/app/*.tsx` | COPY | Next `Link` where TanStack links were used. |
| `openseo:src/client/hooks/useCopy.ts` | `src/components/app/hooks/useCopy.ts` | COPY | — |
| `openseo:src/client/components/QueryState.tsx` (+ `QueryState.test.ts`) | `src/components/app/QueryState.tsx`, `queryStateView.ts` (+ test) | PORT | Decision logic extracted to a pure module so `node --test` covers the same two cases. |
| `openseo:src/client/components/{NavTabs,PermissionHint,StatusScreen,CountryCombobox,LocationSelect,NotFound,DefaultCatchBoundary}.tsx` | `src/components/app/*.tsx` | PORT | Next routing; Perceev copy; required `options`; logo. |
| `openseo:src/shared/safe-url.ts` | `src/shared/safe-url.ts` | COPY | Shared with F02. |
| `openseo:src/client/features/auth/AuthPage.tsx:14-19,131-175` | `src/components/portal/AuthLayout.jsx` | PORT | Same props as today; Perceev mark; legal line kept. |
| `openseo:src/client/features/projects/SettingsTabs.tsx`, `openseo:src/routes/_app/p/$projectId/settings.tsx` | `src/app/portal/settings/layout.tsx`, `src/components/portal/settings/tabs.ts` | PORT | Registry of tabs for later specs. |

## 8. Implementation plan

Branch names `feat/f04-design-system-p<N>`. Every phase ends with the full suite (`npm test`), `npm run typecheck` (from F01 P1), `npm run build`, and the public layout diff.

### Phase 1 — Toolchain: React 19 and Tailwind 4 with no visual change

**Goal:** the app builds on React 19 and Tailwind 4, the render harness still works, and every public page renders the same layout.

- [x] **P1.T1 Dependencies**
  - [x] **P1.T1.S1** *Files:* `package.json`, `package-lock.json`. *Do:* `npm install react@^19.2.0 react-dom@^19.2.0 tailwindcss@^4.1.16 @tailwindcss/postcss@^4.1.16 tw-animate-css@^1.4.0 @base-ui/react@^1.8.0 class-variance-authority@^0.7.1 clsx@^2.1.1 tailwind-merge@^3.3.1 recharts@^3.8.0 react-markdown@^10.1.0 remark-gfm@^4.0.1 @tanstack/react-query@^5.103.2 sonner@^2.0.8` and `npm install -D shadcn@^4.21.0 sucrase@3.35.1 @types/react@^19.2.0 @types/react-dom@^19.2.0`; `npm uninstall tailwindcss-animate`. Keep `next@15.5.27`, `lucide-react@^1.22.0`, the `overrides` block and `engines`. *Verify:* `node -e "console.log(require('react/package.json').version, require('tailwindcss/package.json').version, require('sucrase/package.json').version)"` → `19.x 4.x 3.35.1`; `node -e "require.resolve('shadcn/tailwind.css')"` → exit 0.
  - [x] **P1.T1.S2** *Files:* `postcss.config.mjs`. *Do:* `const config = { plugins: { "@tailwindcss/postcss": {} } }; export default config;`. *Verify:* `npm run build` → exit 0 (after P1.T2).
- [x] **P1.T2 CSS entry and config**
  - [x] **P1.T2.S1** *Files:* `src/app/globals.css`. *Do:* replace lines 31-33 (`@tailwind base; @tailwind components; @tailwind utilities;`) by nothing and insert at the very top of the file (before the first `@font-face`): `@import "tailwindcss";`, `@import "tw-animate-css";`, `@config "../../tailwind.config.js";`. Append the base-layer cursor rule `@layer base { button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; } }`. Keep the existing `@layer base { * { @apply border-border; } }` in this phase. *Verify:* `npm run build` → exit 0; `grep -c "@tailwind" src/app/globals.css` → `0`.
  - [x] **P1.T2.S2** *Files:* `tailwind.config.js`. *Do:* delete `plugins: [require("tailwindcss-animate")]` and the `accordion-down`/`accordion-up` keyframes and animations (tw-animate-css provides them); delete the `content` array (Tailwind 4 detects sources; add `@source "../";` only if a class used by `src/` is missing from the build output — record it in the PR). *Verify:* `npm run build` → exit 0.
- [x] **P1.T3 Guards and audits**
  - [x] **P1.T3.S1** *Files:* `scripts/qa/tw4-class-audit.mjs` (new). *Do:* walk `git ls-files 'src/**/*.js' 'src/**/*.jsx' 'src/**/*.ts' 'src/**/*.tsx'` excluding `src/components/ui/` and `src/components/app/`; inside `className=` strings and `cn(`/`cx(` calls match `\b(shadow|rounded|blur|backdrop-blur|drop-shadow)(-sm)?\b(?!-)`, `\boutline-none\b`, `\bring\b(?!-)`, `\b(bg|text|border|divide|placeholder)-opacity-`, `\bflex-(shrink|grow)`, `\[--[a-z]`, `\btransform\b`, `\bspace-[xy]-`, `\bcontainer\b`; print `file:line: token`; exit 1 when a match is not listed in `scripts/qa/tw4-class-audit.allow.json` (`[{ file, token, reason }]`). *Verify:* `node scripts/qa/tw4-class-audit.mjs` → `0 findings`, exit 0.
  - [x] **P1.T3.S2** *Files:* `scripts/qa/check-f04-public-layout.mjs` (new). *Do:* `capture <origin> <out.json>`: Chromium from `worker/node_modules/playwright`, `reducedMotion: "reduce"`, viewports `{1440,1000}` and `{390,844}`; for each path in `getPublicUrlInventory()` plus `/scan`: `goto` with `networkidle`, wait for `document.fonts.ready`, then for every element with a non-empty box (max 5,000 per page) record `tag`, DOM path (`tag:nth-of-type` chain), rounded `x,y,width,height`, computed `color`, `background-color`, `border-*-width`, `border-*-color` (only when width > 0), `font-family`, `font-size`, `font-weight`, `line-height`, `cursor`, and for `input`/`textarea` the `::placeholder` colour. `compare <base.json> <head.json> <allow.json>`: report every differing element as `path@viewport field: base → head`; exit 1 unless every difference matches an allowlist entry `{ path, route, field, reason }`. *Verify:* run compare on two captures of the same build → `0 differences`.
  - [x] **P1.T3.S3** *Files:* `src/lib/platform/f04Toolchain.test.mjs` (new). *Do:* assert `package.json` dependencies include the P1.T1.S1 names with the given major versions, `devDependencies.sucrase === "3.35.1"`, no `tailwindcss-animate`; `postcss.config.mjs` names `@tailwindcss/postcss`; `globals.css` starts with `@import "tailwindcss";`. *Verify:* `node --test src/lib/platform/f04Toolchain.test.mjs` → pass.
- [x] **P1.T4 React 19 compatibility**
  - [x] **P1.T4.S1** *Do:* run the full suite; for any failure caused by React 19 (`renderToStaticMarkup` output differences, removed APIs), fix the component, not the assertion, unless the assertion pins React 18 serialisation details (then update it and state the reason in the PR). *Verify:* `npm test` → 0 failures.

**Checkpoint:** `npm test`, `npm run typecheck` (when F01 P1 is merged), `npm run build`, `node scripts/qa/tw4-class-audit.mjs` → 0 findings; build `main` in a worktree (`git worktree add ../aeo-f04-base main`, `npm ci`, `npm run build` with CI's placeholder env, `next start -p 3329`) and this branch on 3328; `capture` both and `compare` with an empty allowlist → 0 differences; `npm run qa:public-browser -- http://127.0.0.1:3328` → pass. Completes F04-AC-01, F04-AC-02 (phase 1), F04-AC-03.

### Phase 2 — Tokens, theme, primitives, design authority

**Goal:** app tokens and all 31 primitives exist; theme works on app paths only; `DESIGN.md` and its guards describe the new system; public pages still unchanged.

- [x] **P2.T1 Retire colliding legacy tokens**
  - [x] **P2.T1.S1** *Files:* the 14 files listed in §3 (`src/components/dashboard/{CrawlabilityView,QueryManager,SectionStrap,VisibilityVerdictPanel}.jsx`, `src/components/studio/{AgentBuilder,AgentTheater,AgentsPanel,ContentItemView,KnowledgePanel,LessonsPanel,Markdown,OpportunitiesPanel,StudioView,WeeklyReport}.jsx`). *Do:* replace every `var(--accent)` with `var(--brand)` (identical value today). *Verify:* `git grep -c "var(--accent)" -- src` → no output; `npm test` → pass.
  - [x] **P2.T1.S2** *Files:* `src/app/globals.css`, `tailwind.config.js`. *Do:* delete from `globals.css` the declarations `--accent:` (line 149), `--info:` (177), `--chart-1`…`--chart-5` (217-221) and the block `--background` … `--radius` including `--accent-shadcn*` (286-305); delete the `@layer base { * { @apply border-border; } }` block and the phase-1 cursor rule (both are re-created in `app-theme.css`, §6.6.1 item 7, by P2.T2.S1 in the same PR). In `tailwind.config.js` delete `colors` keys `background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart` and `borderRadius` keys `xs, sm, md, lg, xl` (keep `pill`). *Verify:* `npm run build` → exit 0; `git grep -nE "hsl\(var\(--" -- src tailwind.config.js` → no output.
- [x] **P2.T2 App tokens**
  - [x] **P2.T2.S1** *Files:* `src/styles/app-theme.css` (new), `src/app/globals.css` (add `@import "tailwindcss";`, `@import "tw-animate-css";`, `@import "shadcn/tailwind.css";`, `@import "../styles/app-theme.css";`, `@config …` in that order at the top). *Do:* §6.6.1 items 1–9 exactly. *Verify:* `npm run build` → exit 0.
  - [x] **P2.T2.S2** *Files:* `src/lib/theme/tokens.test.mjs` (new). *Do:* parse `app-theme.css` (regex over `:root {…}` and `:root[data-theme="dark"] {…}` blocks; resolve `var()` references inside the block; support `#rrggbb`, `oklch(L% C H)` and `oklch(L% C H / A%)`); convert oklch → OKLab → linear sRGB (Ottosson matrices: `l_=L+0.3963377774a+0.2158037573b`, `m_=L−0.1055613458a−0.0638541728b`, `s_=L−0.0894841775a−1.2914855480b`, cube each; `R=4.0767416621l−3.3077115913m+0.2309699292s`, `G=−1.2684380046l+2.6097574011m−0.3413193965s`, `B=−0.0041960863l−0.7034186147m+1.7076147010s`); composite alpha in sRGB-encoded space over the pair's background; WCAG relative luminance; assert every pair of §6.6.1 ≥ 4.5 in both themes; assert `--primary` light is `#3730ce`; assert no `data-theme="dark"` or `prefers-color-scheme` text in `globals.css`; assert `app-theme.css` contains `@utility reveal-on-hover`, the 16 px rule of item 6, and no `openseo` string. *Verify:* `node --test src/lib/theme/tokens.test.mjs` → pass (F04-AC-04, F04-AC-14 CSS half).
- [x] **P2.T3 Theme**
  - [x] **P2.T3.S1** *Files:* `src/lib/theme/theme.ts`, `src/lib/theme/theme.test.ts` (new). *Do:* §6.2; tests: `surfaceForPath` for `/`, `/methodology`, `/scan`, `/demo`, `/portal`, `/portal/scans/x`, `/portalx` (site), `/login`, `/auth/reset`, `/ops/measurement`; `resolveTheme` table (9 cases); run `buildThemeInitScript()` with `node:vm` against fake `location`, `localStorage` (including a throwing one), `matchMedia` and a recording `documentElement` → expected `data-theme`/`data-surface` for: `/` + stored dark → light, no surface; `/portal` + stored dark → dark, app; `/portal` + system + OS dark → dark; `/ops/x` + stored dark → light, app; throwing storage → light. *Verify:* `node --test src/lib/theme/theme.test.ts` → pass (F04-AC-05 unit half).
  - [x] **P2.T3.S2** *Files:* `src/components/app/theme/{useThemePreference.ts,ThemePreferenceRadio.tsx,SurfaceSync.tsx}`, `src/components/app/AppToaster.tsx`, `src/app/layout.js`. *Do:* root layout: `<html lang="en" data-theme="light" data-scroll-behavior="smooth" suppressHydrationWarning>`, `<head><script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} /></head>`, body `<SurfaceSync />{children}<AppToaster />` (the `Toaster` import and inline style move into `AppToaster`). *Verify:* `npm run build` → exit 0.
- [x] **P2.T4 Primitives and utilities**
  - [x] **P2.T4.S1** *Files:* `src/lib/utils.ts`, `components.json`, `src/components/ui/*.tsx` (31 files), `src/components/app/hooks/use-mobile.ts`. *Do:* §6.6.2. *Verify:* `npm run build` → exit 0; `npm run typecheck` → exit 0.
  - [x] **P2.T4.S2** *Files:* `src/components/ui/uiInventory.test.mjs` (new). *Do:* assert the 31 file names; each starts with `"use client";` followed by the licence header naming `src/client/components/ui/<name>.tsx`; none contains `from "cn"`, `openseo`, `OpenSEO` outside the header; `dialog.tsx` contains `fullScreenOnMobile`; `chart.tsx` contains `[data-theme=dark]`. *Verify:* `node --test src/components/ui/uiInventory.test.mjs` → pass (F04-AC-06).
  - [x] **P2.T4.S3** *Files:* `THIRD_PARTY_NOTICES.md` (F01 creates it). *Do:* append every COPY/PORT path of this phase to the OpenSEO section. *Verify:* `git grep -c "src/client/components/ui/button.tsx" -- THIRD_PARTY_NOTICES.md` → `1`.
- [x] **P2.T5 Design authority**
  - [x] **P2.T5.S1** *Files:* `DESIGN.md`. *Do:* rewrite with header `> <!-- doc-status -->` / `> **Status: LIVE.** Visual authority, updated 21 October 2026 for the owner's decision to match OpenSEO's customer app (features/F04). Supersedes the 13 October "one light interface" rule for the customer app only.` Sections: **Two surfaces** ("The public website (marketing pages, free scan, dashboard, methodology) keeps one light interface with its own styles in `src/app/globals.css` and `src/components/design-system/primitives.css`. The customer app (`/portal`, sign-in, onboarding, `/ops`) uses the shadcn base-nova system ported from OpenSEO, with light, dark and system themes chosen per browser; `/ops` stays light."); **Tokens** (where they live, primary `#3730CE`, destructive `#B02F2F`, contrast rule ≥ 4.5:1, chart rules: owned-brand series use `--chart-you`, rivals `--chart-rival-*`, categorical series `--chart-1…5`, green/amber/red only for status); **Components** (`src/components/ui`, `src/components/app`, the `ui.jsx` facade, no third palette); **Information and interaction** (keep the existing paragraphs of `DESIGN.md:35-48` verbatim); **Retired** ("Do not restore the split-screen auth showcase, the native workspace `<select>`, the `pv-*` layout classes, OS-driven dark mode on the public website, or a theme switch on public pages."). *Verify:* `node --test src/lib/docStatus.test.mjs` → pass after P2.T5.S2.
  - [x] **P2.T5.S2** *Files:* `src/lib/docStatus.test.mjs`, `src/lib/lightDesign.test.mjs`. *Do:* (reason for both: the owner superseded the one-light-interface rule for the app on 21 October 2026; the guards now protect the public site and the app scoping instead). In `docStatus.test.mjs` replace the body of "GUARD — the live design doc matches the shared light implementation" with: DESIGN.md is LIVE; matches `/public website[\s\S]*one light interface/i` and `/customer app[\s\S]*dark/i`; layout contains `data-theme="light"` and `buildThemeInitScript`; `globals.css` contains `--paper:\s*#F7F7FA` and no `prefers-color-scheme` or `data-theme="dark"`; `app-theme.css` contains `:root[data-theme="dark"]`. Keep "exactly one design authority is LIVE" unchanged. In `lightDesign.test.mjs` replace test 1 with "first server paint is light and dark mode is confined to app paths": compile `src/app/layout.js` with modules `@/components/app/theme/SurfaceSync` → null component, `@/components/app/AppToaster` → null component, `@/lib/theme/theme` → `await import("../lib/theme/theme.ts")`, `autoNull` the three CSS imports; assert `<html[^>]*data-theme="light"`, the script text equals `buildThemeInitScript()`; run the script in `vm` for `/` with stored `"dark"` → `data-theme` `light`; assert `ThemeToggle.jsx` still absent. Keep test 2 unchanged. *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/lightDesign.test.mjs src/components/portal/portalProgress.test.mjs` → pass (F04-AC-12).
- [x] **P2.T6 Branding guard**
  - [x] **P2.T6.S1** *Files:* `src/lib/brandingGuard.test.mjs` (new). *Do:* `git ls-files src` text files; fail on `OpenSEO` (case-insensitive `openseo`) outside lines matching `every-app/open-seo` or `THIRD_PARTY`. *Verify:* `node --test src/lib/brandingGuard.test.mjs` → pass (F04-AC-15).

**Checkpoint:** full suite; build; typecheck; public layout diff vs `main` with empty allowlist → 0 differences (tokens at `:root` must not change public rendering); manual check on `/portal` that nothing changed yet (primitives unused). Completes F04-AC-04, -05 (unit), -06, -12, -15.

### Phase 3 — Shared app components

**Goal:** every shared component of §6.6.3 exists and compiles; nothing uses them yet except a fixture page in the browser harness.

- [x] **P3.T1 Components**
  - [x] **P3.T1.S1** *Files:* `src/components/app/{PageHeader,PageFrame,EmptyState,ErrorState,SkeletonPresets,ConfirmDialog,InlineConfirm,CopyButton,Spinner,SegmentedToggle,HelpLabel,GateCard,RowActionsMenu,ChartAxes,CardShell,FormDialog,FormActions,SafeExternalLink,ExpandableList,Markdown,StatusScreen,PermissionHint,CountryCombobox,LocationSelect,AppBanner,NotFound,ErrorBoundaryCard,NavTabs}.tsx`, `src/components/app/brand/PerceevLogo.tsx`, `src/components/app/hooks/useCopy.ts`, `src/components/app/errors/describeError.ts`, `src/shared/safe-url.ts`. *Do:* §6.6.3. *Verify:* `npm run typecheck` → exit 0; `npm run build` → exit 0.
  - [x] **P3.T1.S2** *Files:* `src/components/app/queryStateView.ts`, `src/components/app/QueryState.tsx`, `src/components/app/queryStateView.test.ts`. *Do:* the two OpenSEO cases (`QueryState.test.ts:19-42`) plus pending and success. *Verify:* `node --test src/components/app/queryStateView.test.ts` → pass (F04-AC-07).
  - [x] **P3.T1.S3** *Files:* `src/shared/safe-url.test.ts` (new unless F02 created it). *Do:* `javascript:` → null; `https://u:p@x` → null; `https://example.com/a` → unchanged; `safeHostname("https://www.a.com/x")` → `a.com`. *Verify:* `node --test src/shared/safe-url.test.ts` → pass.
- [x] **P3.T2 Providers**
  - [x] **P3.T2.S1** *Files:* `src/components/app/providers/AppProviders.tsx`. *Do:* `TooltipProvider` wrapper. *Verify:* build → exit 0.

**Checkpoint:** suite, typecheck, build, public layout diff → 0. Completes F04-AC-07.

### Phase 4 — App shell, navigation, settings, features route

**Goal:** the portal renders in the new shell with the registry sidebar; `/portal/settings` exists; the portal browser harness runs in CI.

- [ ] **P4.T1 Features route**
  - [ ] **P4.T1.S1** *Files:* `src/lib/features/clientFeatures.ts`, `src/lib/features/features.contract.ts`, `src/app/api/customer/features/route.ts`. *Do:* §6.2, §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [ ] **P4.T1.S2** *Files:* `src/lib/features/features.route.test.mjs` (new; customer route hook pattern of `src/lib/customerRoutes.test.hooks.mjs`). *Do:* cases: member with `CLIENT_FEATURES = ["a","b"]` injected via `readClientFeatures` deps (a on, b off) → 200 `{ features: { a: true, b: false } }` and `Cache-Control: no-store`; evaluation throws for `b` → `b: false`; no session → 401 `unauthenticated`; a brand the user is not a member of → 404 `workspace_not_found`; extra query key `x=1` → 400 `invalid_request`. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/features/features.route.test.mjs` → pass (F04-AC-09).
- [ ] **P4.T2 Navigation**
  - [ ] **P4.T2.S1** *Files:* `src/components/app/navigation/navModel.ts`, `navModel.test.ts`, `items.ts`. *Do:* §6.6.5; tests: flagged item hidden for `features` undefined / `{f:false}`, shown for `{f:true}`; `ownerOnly` hidden for members; a group whose items are all hidden is dropped; `/portal` active only for exact; `/portal/scans/abc` → `scans`; `/portal/questions/q1` → `questions`; `sectionPathForSwitch` maps `/portal/scans/abc` → `/portal/scans`, `/portal/settings` → `/portal/settings`, `/portal/unknown/x` → `/portal`. *Verify:* `node --test src/components/app/navigation/navModel.test.ts` → pass (F04-AC-08).
- [ ] **P4.T3 Shell**
  - [ ] **P4.T3.S1** *Files:* `src/components/app/shell/{AppShell,AppSidebar,WorkspaceSwitcher,MobileTopBar,AccountMenu,ScanRunningCard}.tsx`, `src/components/portal/PortalShell.jsx`, `src/app/portal/layout.jsx`. *Do:* §6.6.4. `PortalShell` fetches features with a plain `fetch` to `/api/customer/features?brand_key=` in the same effect that loads overview (keyed by `brandKey`, ignored when the brand changed before it resolved, `features` added to the context value as `features: Record<string, boolean> | null`); F05 moves it to a query. Remove `PortalFrame` (no other importer: `git grep -n PortalFrame -- src` shows only `PortalShell.jsx`). *Verify:* `npm run build` → exit 0; `node --test src/components/portal/` → pass.
  - [ ] **P4.T3.S2** *Files:* `src/app/portal/not-found.tsx`, `src/app/portal/error.tsx`. *Do:* render `NotFound` / `ErrorBoundaryCard` (`error.tsx` is a client component receiving `{ error, reset }`). *Verify:* build → exit 0.
- [ ] **P4.T4 Settings**
  - [ ] **P4.T4.S1** *Files:* `src/app/portal/settings/layout.tsx`, `src/app/portal/settings/page.tsx`, `src/components/portal/settings/tabs.ts`. *Do:* §6.6.6. *Verify:* build → exit 0.
- [ ] **P4.T5 Browser harness**
  - [ ] **P4.T5.S1** *Files:* `scripts/qa/portalFixtureHarness.mjs` (new), `tests/fixtures/portal/{session.json,memberships.json,overview-acme.json,overview-beta.json,gsc-acme.json,features-acme.json,scans-acme.json,report-scan-1.json,panel-acme.json,team-acme.json,content-acme.json}` (new, invented data: workspaces `acme` (owner, website `https://acme.example`) and `beta` (member)). *Do:* export `async function openPortal(browser, origin, { viewport, theme?, fixtures? })`: new context with `reducedMotion: "reduce"`; route `https://placeholder.supabase.co/auth/v1/token?grant_type=password` → session fixture (tokens built at runtime from `{"alg":"none"}` and `{"sub":"qa-user","exp":<now+3600>}` base64url, never a literal), `/auth/v1/user` → user, `/rest/v1/rpc/accept_customer_team_invites` → `null`, `/rest/v1/customer_brand_memberships*` → memberships; route `**/api/customer/**` GETs to fixture files by path and `brand_key`; **abort every non-GET to `/api/customer/scan`, `/api/customer/content`, `/api/customer/gsc/*`, `/api/customer/team`** and count them in `blockedWrites`; sign in through `/login` (fill "Work email", "Password", click "Sign in"); return `{ context, page, blockedWrites }`. *Verify:* `node scripts/qa/check-f04-browser.mjs http://127.0.0.1:3328` (after P4.T5.S2) reaches `/portal`.
  - [ ] **P4.T5.S2** *Files:* `scripts/qa/check-f04-browser.mjs` (new), `package.json` (script `"qa:f04-browser": "node scripts/qa/check-f04-browser.mjs"`), `.github/workflows/ci.yml` (job `build`, step "public site and measurement browser contracts": add `node scripts/qa/check-f04-browser.mjs http://127.0.0.1:3328` after `check-repair-browser.mjs`). *Do:* cases, each written as a `record()`d row like `check-public-browser.mjs`:
    - `F04-B01` desktop 1440: sidebar visible, width 240 px ± 1, groups "AI Visibility", "My Site", "Content", "Settings" present, items Overview/Questions/Scans/Search Console/Content Studio/Team/Workspace settings; Overview has `aria-current="page"` on `/portal`; on `/portal/scans` Scans has it.
    - `F04-B02` mobile 390: sidebar hidden; top bar trigger opens the drawer; Escape closes; `Meta+B` (`Control+B` on Linux) toggles it.
    - `F04-B03` theme: open account menu → Dark → `html[data-theme="dark"]`; reload → still dark before first `requestAnimationFrame` (read the attribute in an `addInitScript` that captures it at `DOMContentLoaded`); navigate to `/` via `page.goto` → `data-theme="light"` and no `data-surface`; back to `/portal` → dark.
    - `F04-B04` switcher: on `/portal/scans/scan-1` choose "Beta" → URL `/portal/scans`, header workspace name "Beta", `localStorage["perceev-portal-brand"] === "beta"`.
    - `F04-B05` features: after sign-in exactly one `GET /api/customer/features?brand_key=acme` is made; after switching to Beta exactly one with `brand_key=beta`; the sidebar shows the same items for both (no flagged items exist in F04; flag gating itself is unit-tested in `navModel.test.ts`).
    - `F04-B06` member: as `beta` (member) the Team item is absent.
    - `F04-B08` `meta[name=google][content=notranslate]` present on `/portal` and `/login`, absent on `/`; `#app-content` ancestor has `translate="no"`.
    - `blockedWrites` is 0 at the end of every case.
    *Verify:* locally build with CI's placeholder env, `next start -p 3328`, run → all cases pass (F04-AC-10, F04-AC-13).

**Checkpoint:** suite, typecheck, build, public layout diff → 0, `check-f04-browser.mjs` pass, `check-public-browser.mjs` pass. Completes F04-AC-08, -09, -10, -13.

### Phase 5 — Workspace pages (requires `fix/run-scan-unapproved-panel` merged)

**Goal:** Overview, Scans, scan report and Questions & evidence look like OpenSEO pages; the facade is re-skinned; tests pass.

- [ ] **P5.T1 Facade**
  - [ ] **P5.T1.S1** *Files:* `src/components/portal/ui.jsx`. *Do:* §6.6.8 rule 4 for every export; `PageHeader` renders OpenSEO's header markup with `eyebrow` as `<p className="text-sm text-muted-foreground">` above the `h1`; `TopLoadingBar` renders `div.fixed.inset-x-0.top-0.z-50.h-0.5.overflow-hidden` with an animated `bg-primary` bar (`role="progressbar" aria-label="Loading"` kept); `Spinner` renders the `Loader2` icon with `animate-spin` and keeps `role="status" aria-label`. *Verify:* `node --test src/components/portal/` → pass (portalProgress, portalRegressions, tenantWorkspace unchanged).
  - [ ] **P5.T1.S2** *Files:* `src/components/portal/portal.css`. *Do:* delete every rule except `.pv-progress--unmeasured` (hatched `repeating-linear-gradient(135deg, color-mix(in oklch, var(--foreground) 12%, transparent) 0 4px, transparent 4px 8px)`), `.pv-progress--indeterminate .pv-progress__fill`/sweep keyframes, `.pv-progress.is-active .pv-progress__fill` sheen, `.pv-steps`/`.pv-step*` (re-pointed to `var(--primary)`, `var(--border)`, `var(--muted-foreground)`, `var(--destructive)`), and the `prefers-reduced-motion` block. *Verify:* `node --test src/lib/lightDesign.test.mjs` → pass (portal.css still has no `^.pv-btn {` or `^.pv-card {`).
  - [ ] **P5.T1.S3** *Files:* `src/components/portal/uiFacadeParity.test.mjs` (new). *Do:* read `src/components/ui/{button,badge,alert,card}.tsx` as text, extract the `cva(` base string and variant strings with a regex; compile `ui.jsx` with the harness; render `Button` for each mapped variant/size, `Badge` for each tone, `Banner` for each tone, `Card`; assert each rendered `class` contains every class token of the matching primitive string (order-insensitive) plus the kept hook classes. *Verify:* `node --test src/components/portal/uiFacadeParity.test.mjs` → pass (F04-AC-16).
- [ ] **P5.T2 Overview** — *Files:* `src/app/portal/page.jsx`, `src/components/portal/overview/{GettingStarted,KpiRow,VisibilityTrend,RecentScans,ContentStudioCard}.jsx`, `overview/overview.css` (deleted), `src/components/portal/ScanProgressCard.jsx`.
  - [ ] **P5.T2.S1** *Do:* rule 5 replacements; `KpiRow` → stat grid `grid grid-cols-2 gap-3 lg:grid-cols-4` of facade `Stat`s (loading: `SkeletonStatGrid` look via facade `Skeleton`s); `GettingStarted`, `RecentScans`, `ContentStudioCard`, `VisibilityTrend` → facade `Card` with OpenSEO `CardShell` header look (title row with `border-b`); `VisibilityTrend` keeps its bar list and empty state (Trend comparability is a deferred Mixed row); `ScanProgressCard` keeps `data-testid`, stage steps, banners. *Verify:* `node --test src/components/portal/` → pass.
- [ ] **P5.T3 Scans list** — *Files:* `src/app/portal/scans/page.jsx`, `src/components/portal/scans/MockScanPanel.jsx`, `scans/mock-scan.css` (deleted), `scans/scans.css` (only `.pv-scans-meter` rules kept, re-pointed to `--chart-you`/`--chart-rival-1`).
  - [ ] **P5.T3.S1** *Do:* list rows rule 5; each row a `Link` with `reveal-on-hover` chevron; facade components. *Verify:* `node --test src/components/portal/tenantWorkspace.test.mjs` → pass.
- [ ] **P5.T4 Scan report** — *Files:* `src/app/portal/scans/[scanId]/page.jsx`, `src/components/portal/scans/ReportCards.jsx`.
  - [ ] **P5.T4.S1** *Do:* add a `backLink` prop to the facade `PageHeader` (rendered above the header block, as `openseo:src/client/components/PageHeader.tsx:37-43`); the page replaces its "All scans" ghost button with `backLink={<a href="/portal/scans" className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-4" aria-hidden="true" />All scans</a>}` (a plain anchor and the already-imported `ArrowLeft`, so the test's module map is unchanged); KPI grid rule 5; `ReportCards` question rows `rounded-lg border border-border`, answer blocks `bg-muted/50 rounded-md p-3`; keep the download button (F06 replaces it). *Verify:* `node --test src/components/portal/portalRegressions.test.mjs` → pass.
- [ ] **P5.T5 Questions & evidence** — *Files:* `src/app/portal/measurement/page.jsx` (the `main` version; the earlier restyle branch was dropped on 25 Oct 2026, so this task does the restyle), `src/components/portal/portalRegressions.test.mjs`.
  - [ ] **P5.T5.S1** *Do:* restyle with the facade and rule 5, keeping data flow, request bodies and the generation/activeBrand guards unchanged: `PageHeader` title "Questions and evidence"; the question panel is the **first** `Card` (title "Question panel") with a state `Badge` ("No panel" / "Draft" / "Approved") and its version; textarea `aria-label="Questions, one per line"`, `rows={14}`, classes `w-full rounded-lg border border-input bg-background px-3 py-2 text-base md:text-sm`, with a live count line "{n} questions" (`text-sm text-muted-foreground`); "Approve this panel" is the primary `Button`, "Save for review" `variant="secondary"`; once approved, a "Run scan" `Button` with `onClick={scan.start}` (the shell's own start, so F09's dialog applies); evidence, history, scheduled windows and publications as `Card`s with `<details>`/`<summary>` rows `rounded-lg border border-border px-4 py-3`; no horizontal scroll at 375 px; no new CSS file. *Verify:* `node --test src/components/portal/portalRegressions.test.mjs` → pass.
  - [ ] **P5.T5.S2** Add a page test in `portalRegressions.test.mjs`: with an approved fixture panel (2 prompts) the header title, first card title, "Approved" badge, Run scan wired to `scan.start`, textarea rows 14, "2 questions", primary/secondary button variants, and that clicking "Approve this panel" posts exactly the same request body as on `main` (`key`, `expected_version`, `state`, `payload` with `persona`, `context` incl. `device: "desktop"` and `session_policy: "fresh_anonymous"`, prompts with `origin: "manual"`, `weight: 1`). *Verify:* pass.
- [ ] **P5.T6 Public layout diff with allowlist**
  - [ ] **P5.T6.S1** *Files:* `scripts/qa/f04-layout-allow.p5.json` (new). *Do:* run capture/compare against `main`; allowlist only `/demo` entries with reason "renders portal components, which adopt the app look". *Verify:* compare → exit 0 with only `/demo` entries (F04-AC-02 phase 5).

**Checkpoint:** suite; build; `check-f04-browser.mjs` extended with `F04-B07` for `/portal`, `/portal/scans`, `/portal/scans/scan-1`, `/portal/measurement` (one `h1`; `scrollWidth ≤ innerWidth + 1` at 390; no `.pv-app, .pv-sidebar, .pv-page-header`); screenshots of each at 1440 and 390 attached to the PR. Completes F04-AC-16 and part of F04-AC-11.

### Phase 6 — Content, Search Console, Team, auth pages, cleanup

**Goal:** every remaining surface is migrated; legacy layout CSS is gone.

- [ ] **P6.T1 Content Studio** — *Files:* `src/app/portal/content/page.jsx`, `src/components/portal/content/{ContentStudio,ComposerCard,GenerationQueue,DraftsLibrary,DraftEditor,ReviewFindings}.jsx`, `content/content.css`.
  - [ ] **P6.T1.S1** *Do:* rule 5; `ComposerCard` native `<select>`/`<textarea>` keep their elements (test asserts `<option>`) with Input classes; Studio canvas components under `src/components/studio/` are not edited (dark mode reaches them through the legacy bridge). *Verify:* `node --test src/components/portal/tenantWorkspace.test.mjs src/components/portal/portalRegressions.test.mjs` → pass.
- [ ] **P6.T2 Search Console** — *Files:* `src/components/portal/gsc/{GscPage,PerformanceCard,PropertyPicker}.jsx`, `gsc/gsc.css`.
  - [ ] **P6.T2.S1** *Do:* restyle only (Mixed row): facade components and rule 5; the query table uses `src/components/ui/table.tsx` primitives (`TableCard`, `Table`, `TableHeader`, `TableRow`, `TableHead`, `TableCell`) with the same columns and numbers. *Verify:* build → exit 0; browser `F04-B07` on `/portal/search-console`.
- [ ] **P6.T3 Team** — *Files:* `src/components/portal/team/TeamPage.jsx`, `team/team.css` (deleted).
  - [ ] **P6.T3.S1** *Do:* restyle only (Mixed row); member and invite lists as `Table` primitives; remove action uses `InlineConfirm` with `label="Remove {email}"` and the same API call. *Verify:* browser `F04-B07` on `/portal/team`.
- [ ] **P6.T4 Auth** — *Files:* `src/components/portal/AuthLayout.jsx`, `auth.css` (deleted), `src/app/login/page.jsx`, `src/app/signup/page.jsx`, `src/app/onboarding/page.jsx`, `src/app/auth/accept/page.jsx`, `src/app/auth/reset/page.jsx`, new `src/app/{login,signup,onboarding}/layout.jsx`, `src/app/auth/layout.jsx`.
  - [ ] **P6.T4.S1** *Do:* §6.6.7; copy and handlers unchanged. *Verify:* `check-f04-browser.mjs` sign-in still reaches `/portal`; `F04-B07` on `/login`, `/signup`, `/onboarding` (fixture `GET /api/customer/onboard` → `{ has_workspace: false }`).
- [ ] **P6.T5 Ops providers**
  - [ ] **P6.T5.S1** *Files:* `src/app/ops/layout.jsx` (new). *Do:* `AppProviders` wrapper only (no shell, no metadata change). *Verify:* build → exit 0; `/ops/measurement` renders light with `data-surface="app"`.
- [ ] **P6.T6 Cleanup and guards**
  - [ ] **P6.T6.S1** *Files:* `src/components/portal/legacyMarkupGuard.test.mjs` (new). *Do:* `git grep` over `src/app/portal`, `src/components/portal`, `src/app/{login,signup,onboarding,auth}` (excluding tests and `ui.jsx`) fails on `pv-app`, `pv-sidebar`, `pv-page-header`, `pv-auth`, `pv-stack`, `pv-grid`, `pv-center`. *Verify:* `node --test src/components/portal/legacyMarkupGuard.test.mjs` → pass (F04-AC-11 unit half).
  - [ ] **P6.T6.S2** *Files:* `DESIGN.md`. *Do:* add an "Implementation" list of the final file paths. *Verify:* `node --test src/lib/docStatus.test.mjs` → pass.
  - [ ] **P6.T6.S3** *Files:* `features/README.md`. *Do:* F04 status → Merged. *Verify:* `git grep -n "F04-design" -- features/README.md` shows "Merged".

**Checkpoint:** suite, typecheck, build, `check-f04-browser.mjs` all cases (F04-B07 on every portal and auth page), `check-public-browser.mjs`, public layout diff with the P5 allowlist only. Completes F04-AC-11 and F04-AC-14 (browser `F04-B09`: an input on `/login` computes `font-size: 16px` at 390; a `reveal-on-hover` button on `/portal/scans` has opacity 0 until its row is hovered and 1 after; `getComputedStyle(document.body).fontFamily` on `/portal` starts with `ui-sans-serif`, and on `/` starts with `Archivo`).

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/platform/f04Toolchain.test.mjs` | dependency versions, sucrase pin, PostCSS plugin, CSS entry | 01 |
| CI `tests` / `build` | full suite, typecheck, build | 01, 03 |
| `scripts/qa/check-f04-public-layout.mjs` | capture/compare public inventory + `/scan` at two viewports | 02 |
| `src/lib/theme/tokens.test.mjs` | contrast pairs both themes, primary value, scoping, utilities present | 04, 14 |
| `src/lib/theme/theme.test.ts` | surface table, resolve table, init script in `vm` (5 scenarios) | 05 |
| `src/components/ui/uiInventory.test.mjs` | 31 files, headers, `use client`, no `cn` package, no branding | 06 |
| `src/components/app/queryStateView.test.ts` | four states incl. OpenSEO's two | 07 |
| `src/components/app/navigation/navModel.test.ts` | flags, owner, empty groups, active matching, switch target | 08 |
| `src/lib/features/features.route.test.mjs` | success, failing flag, 401, 404, 400 | 09 |
| `scripts/qa/check-f04-browser.mjs` | B01–B09 | 05, 10, 11, 13, 14 |
| `src/lib/docStatus.test.mjs` (updated), `src/lib/lightDesign.test.mjs` (updated) | design authority and scoping | 12 |
| `src/lib/brandingGuard.test.mjs` | no OpenSEO branding | 15 |
| `src/components/portal/uiFacadeParity.test.mjs` | facade classes = primitives | 16 |
| `src/components/portal/legacyMarkupGuard.test.mjs` | legacy layout classes gone | 11 |
| Existing `portalProgress`, `portalRegressions`, `tenantWorkspace` | unchanged assertions | 03, 16 |

Fixtures: `tests/fixtures/portal/*.json` — invented workspaces, users, scans and answers; no real customer data, no credentials; token strings are generated at runtime by the harness.

## 10. Rollout and rollback

- **Env vars:** none new.
- **Flags:** none. The sidebar shows flagged items of other specs only when their `CLIENT_FEATURES` flags are on.
- **Order:** P1 can merge before F01. P2 and P3 need F01 P1 (`tsconfig.json`; `.tsx` files). P4 needs F01 P1–P2. P5 needs `fix/run-scan-unapproved-panel` merged. Each phase deploys safely alone: P1–P3 change nothing visible; P4 swaps the shell; P5–P6 restyle pages.
- **Rollback:** revert the phase PR. No data, no migrations. Theme preference keys left in browsers are harmless.
- **Owner steps:** none beyond reviewing P4–P6 screenshots in the PRs.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | Typography: OpenSEO uses system fonts; Perceev's brand font is Archivo. | App uses OpenSEO's system stacks (`--app-font-sans`); the logo keeps Archivo; the public site keeps Archivo. Owner can switch the app to Archivo by changing one token. |
| 2 | `/demo` (public) renders portal components and will adopt the app look in phase 5. | Accept (it demonstrates the product); allowlisted in the layout diff. If the owner wants `/demo` frozen, add a site-scoped copy of the old facade in a follow-up. |
| 3 | The `cn` npm package's merge semantics are unverified. | Use `clsx` + `tailwind-merge` (stock shadcn); overrides resolve deterministically. Visual parity is checked by the P4–P6 screenshots. |
| 4 | OpenSEO's Cmd/Ctrl+B only toggles the mobile drawer; the desktop sidebar cannot collapse. | Parity kept. A desktop collapse would be a later owner request. |
| 5 | Tailwind 4 `@config` compatibility for `transitionTimingFunction.DEFAULT`, `fontFamily` and theme-variable emission. | The layout diff catches static differences on public pages. In the app, browser case `F04-B09` also checks that an element with the `font-sans` utility computes the system stack; if it computes Archivo, add `[data-surface="app"] .font-sans { font-family: var(--app-font-sans); }` and `[data-surface="app"] .font-mono { font-family: var(--app-font-mono); }` to `app-theme.css` and record it in the PR. |
| 6 | Split-screen auth showcase removed (OpenSEO has a single column). | Removed; listed under "Retired" in DESIGN.md. |
| 7 | Group labels at OpenSEO's 40 % opacity fail AA (≈ 2.5:1). | 65 % (≈ 5:1); otherwise identical. |
| 8 | `shadcn/tailwind.css` content is not verified offline. | Imported as OpenSEO does; P1.T1.S1 verifies it resolves; if the build fails on it, inline its custom variants into `app-theme.css` (record the lines in the PR). |
| 9 | React 19 may change `renderToStaticMarkup` details asserted by tests. | Fix components first; update only serialisation-detail assertions with the reason (P1.T4.S1). |
| 10 | F01 installs `@types/react@^18.3`. | F04 P1 bumps to `^19.2`; F01 should not pin 18 if F04 lands first. |
| 11 | Supabase-js may reject non-JWT access tokens in the browser harness. | The harness builds an unsigned JWT-shaped token at runtime (`alg: none`); never a literal key. |
| 12 | `/ops` pages under `data-surface="app"` pick up app fonts and border defaults. | Accepted; `/ops` is operator-only and forced light. |

## 12. Definition of done

- [ ] Phases 1–6 merged; every subtask ticked.
- [ ] F04-AC-01 … F04-AC-16 covered by passing tests or recorded browser runs.
- [ ] `npm test`, `npm run typecheck`, `npm run build` green on `main`.
- [ ] Public layout diff against the pre-F04 `main` shows only the `/demo` allowlist.
- [ ] `check-f04-browser.mjs` runs in CI's `build` job and passes.
- [ ] `DESIGN.md` rewritten; `THIRD_PARTY_NOTICES.md` lists every COPY/PORT path.
- [ ] `features/README.md` status updated (In progress at the first PR, Merged at the last).

## Deviations from conventions

1. **`src/lib/theme/theme.ts` and `src/components/app/queryStateView.ts`, `navigation/navModel.ts` are pure modules tested under `node --test`.** `.tsx` stays browser-tested (conventions §3); logic that needs unit coverage is moved out of `.tsx`.
2. **`cn` uses `clsx` + `tailwind-merge`** instead of OpenSEO's `cn` package (risk 3).
3. **Sidebar group labels at 65 % instead of 40 %**, and **`--destructive` light `#B02F2F`**, for WCAG AA (Perceev's legibility rule in `DESIGN.md`).
4. **New shared registry `CLIENT_FEATURES`** (`src/lib/features/clientFeatures.ts`) and route `GET /api/customer/features`; conventions §5 should list them (requested in the final report).
5. **`APP_SURFACES`** in `src/lib/theme/theme.ts` is a registry later specs append to (F23 `/r`).
6. **Auth showcase panel removed** to match OpenSEO's single-column auth pages.
