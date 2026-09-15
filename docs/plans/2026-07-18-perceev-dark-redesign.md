# Perceev Dark Redesign — Implementation Plan

> <!-- doc-status -->
> **Status: SUPERSEDED-BY** [DESIGN.md](../../DESIGN.md). The dark redesign this plan describes was replaced by the Signal Box design system ported in `5111219`.

**Date:** 2026-07-18
**Source:** `C:\Users\Vismay\Downloads\Perceev Design System\design_handoff_perceev_dark_redesign\`
**Scope:** UI/UX only — zero backend, zero data shape, zero API changes
**Branch:** `feat/perceev-dark-redesign` (created from `main`)

---

## 0. Executive Summary

Replace the current light-cream/serif "AnswerRank" visual identity with the Perceev dark-mode design system. Every page, every component, every design token changes — but every test ID, every API call, and every data flow stays exactly as-is.

### 0.1 What changes

| Layer | Before | After |
|-------|--------|-------|
| **Background** | `#FDFBF7` warm cream | `#0E0D0B` warm graphite |
| **Accent** | `#D9531E` burnt orange | `#E8632C` ember |
| **Fonts** | Cormorant Garamond + IBM Plex Sans (Google CDN) | Geist + Geist Mono (local `@font-face`, already at `src/app/fonts/`) |
| **Landing** | Traditional editorial sections | Split-screen dossier (left fixed panel + right scrolling stream) |
| **Dashboard** | Navbar + tabs (Overview/BrandPresence/Queries/Citations) | Sidebar (236px) + 5 views (Overview/Answers/Rivals/Sources/Queries) |
| **Scan** | Form with staged progress loader | Same flow, restyled with design tokens + ScoreMeter |
| **Brand** | "AnswerRank" wordmark | "perceev" wordmark (final "v" in accent `#E8632C`) |
| **Components** | Hardcoded hex colors, no shared primitives | Design system primitives referencing CSS custom properties |
| **Meters** | Smooth bars or none | **Segmented ScoreMeter**: 20-40 rounded segments |

### 0.2 What does NOT change

- All backend (`src/lib/`, `src/services/`, `src/app/api/`)
- All data shapes and `normalizeResult()` output
- All test IDs (`data-testid` attributes)
- All routing paths, API signatures, event handlers
- The `src/lib/scoring/` pipeline
- All 46 shadcn/ui files in `src/components/ui/` (tokens updated, not removed)

### 0.3 Hard rules

1. No backend changes.
2. Preserve every `data-testid` attribute.
3. Preserve every `useState`, `useEffect`, `useMemo`, and handler.
4. Work phase by phase. Each depends on the previous.
5. Don't delete old files until Phase 6 — create new alongside, swap imports, then delete.

---

## Phase 1 — Design Token Foundation

### Step 1.1 — Replace `src/app/globals.css` (OVERWRITE)

Current: 109 lines — Google Font imports, HSL shadcn tokens, light styles.

New file (~300 lines): local `@font-face` for Geist + Geist Mono, all CSS custom properties from the design system tokens, shadcn compatibility mappings, base element styles, scrollbar, animation keyframes (caret-blink, pulse-fade, shimmer, accordion).

**Token groups ported:**
- Surfaces: `--bg-0` (#0E0D0B) → `--bg-3` (#242019)
- Borders: `--border-1` (#26221C) → `--border-3` (#524A3E)
- Text: `--text-1` (#EDE7DC), `--text-2` (#A69D8F), `--text-3` (#746C5F)
- Accent: `--accent` (#E8632C) + hover/press/fg/soft/border/text variants
- Semantic: `--good/warn/crit/info` with bg/border variants
- Typography: `--font-sans/mono`, `--type-display-xl` through `--type-mono-body`, tracking vars
- Spacing: `--space-1..11`, `--container-max`, `--control-h-sm/md/lg`
- Effects: `--radius-1/2`, `--shadow-pop/glow`, `--ease-out`, `--dur-fast/med`, `--focus-ring`
- shadcn compat: `--background → var(--bg-0)`, `--primary → var(--accent)`, etc.

### Step 1.2 — Update `tailwind.config.js` (EDIT)

Three sections change:
1. **fontFamily**: Replace Cormorant/IBM Plex with Geist/Geist Mono
2. **colors**: Replace `hsl(var(--primary))` with direct `var(--primary)` references
3. **keyframes**: Add `shimmer` for skeleton loading

### Step 1.3 — Verify font files exist in `src/app/fonts/`

GeistVF.woff and GeistMonoVF.woff already present.

### Step 1.4 — Update `src/app/layout.js` metadata

Change title to "Perceev | Answer Engine Intelligence", description to "AI is answering your buyers. Know where you stand."

### ✅ Phase 1 verification: `npm run build`

---

## Phase 2 — New Design System Components

### Directory: `src/components/perceev/` (14 files)

| # | File | Purpose |
|---|------|---------|
| 1 | `Wordmark.jsx` | "perceev" type logo, final "v" in accent |
| 2 | `ScoreMeter.jsx` | **Signature motif**: N rounded segments, `role="meter"` |
| 3 | `Button.jsx` | 4 variants × 3 sizes, mono uppercase, hover via onMouseEnter/Leave |
| 4 | `Badge.jsx` | 6 semantic variants, optional 5px dot, `tierVariant()` helper |
| 5 | `Card.jsx` | `--bg-1` fill, hairline, 6px radius, padded + flush variants |
| 6 | `KpiCard.jsx` | Mono label, big tabular numeral, denominator sub-line, 4 tones |
| 7 | `HeroScoreCard.jsx` | Glowing/accent-bordered, radial gradient, ScoreMeter, stats |
| 8 | `Input.jsx` | `--bg-1` fill, accent focus ring, mono label above, error msg |
| 9 | `Select.jsx` | Native select styled like Input, Lucide chevron |
| 10 | `Tabs.jsx` | Mono uppercase, accent underline, optional count badge |
| 11 | `Alert.jsx` | Semantic banner, auto-icon, optional title + action |
| 12 | `Skeleton.jsx` | Shimmer pulse over `--bg-2` |
| 13 | `Sidebar.jsx` | 236px, brand chip, 5 nav items w/ icons, scan history, CTA |
| 14 | `index.js` | Barrel export |

**Pattern:** Tailwind for layout + inline `style` for token values. No CSS files per component.

---

## Phase 3 — Landing Page Rewrite

### New directory: `src/components/landing/` (6 files)

| # | File | Purpose |
|---|------|---------|
| 15 | `ScanBar.jsx` | 52px input + "Run a check" Button, navigates to `/scan` |
| 16 | `ProbeCounter.jsx` | Animated counter, ticks up every 2.2s by 1-3 |
| 17 | `AnswerDemo.jsx` | Typed-out AI Overview (24ms/3-char), brand green/rivals red highlights, cycles 3 scenarios (3.2s pause) |
| 18 | `VerdictModule.jsx` | Static "64/100" + 40-seg ScoreMeter + tier badge |
| 19 | `DossierLeftPanel.jsx` | Fixed 42vw (min 420px) panel: wordmark, headline, ScanBar, probe counter, module nav (01-05), faint ember glow |
| 20 | `DossierModules.jsx` | Right stream: 5 numbered Module sections, 88px gutter, hairline separators, footer |

### Rewrite `src/app/page.js` (OVERWRITE)

Remove all old imports. New: `<DossierLeftPanel />` + `<main style={{ marginLeft }}>` wrapping `<DossierModules />` + `<footer>`.

The old "See a sample report" button → new Begin module (05) must still call `saveScan(SAMPLE_RESULT)` + `router.push("/dashboard")`.

---

## Phase 4 — Scan Page Rewrite

### Rewrite `src/app/scan/page.js` (OVERWRITE)

**Preserve all logic:** useState (brand/website/industry/competitors/errors/scanning/stage/progress/failed), useEffect (fetchIndustries), validate(), start() with runScan progress callback, saveScan, toast, RECENT array, SAMPLE_RESULT.

**Change only styling:**
- Remove `import { Navbar }`, add slim top bar with Wordmark + "New scan"
- Remove `import { motion, AnimatePresence }` — use CSS transitions
- Add imports: Wordmark, Button, Input, Select, ScoreMeter, Alert
- Replace all hex colors → token references
- Replace `<input>` → `<Input>`, shadcn `<Select>` → Perceev `<Select>`, `<button>` → `<Button>`
- Replace smooth progress bar → `<ScoreMeter segments={20} value={progress} />`
- Replace recent scans grid → individual dark-themed cards
- Replace error banner → `<Alert variant="crit">`

**Preserve all 12 `data-testid` values** exactly as-is.

---

## Phase 5 — Dashboard Rewrite

### Rewrite `src/app/dashboard/page.js` (OVERWRITE)

**CRITICAL: Preserve all state, hooks, and handlers:**

State: `[result, setResult]`, `[history, setHistory]`, `[isScanning, setIsScanning]`, `[scanError, setScanError]`, `[view, setView]` (renamed from `activeTab`).

useEffect: loadScan → normalizeResult → setResult + fetchScanHistory.

useMemo: scoreTrend, previousScan, sortedHistory from [result, history].

Derived: dataSourceIssue, tier, brandAliases, mentionedNonBranded, citedNonBranded, hasBrandedData.

Handlers: handleHistoryClick (normalizeResult + setResult), handleRerun (exact same body — import runScan/saveScan dynamically, call runScan, saveScan, setResult, fetchScanHistory).

**New layout:**

```
<div class="flex min-h-screen">
  <Sidebar />        (236px)
  <main class="flex-1 flex flex-col h-screen overflow-hidden">
    Header strip     (view title + Export + Re-run)
    Banners          (scanError, sample, dataSourceIssue, insufficientSample)
    ScoreBand        (84px score + 40-seg meter, only on overview + !dataSourceIssue)
    View routing     (overview | answers | rivals | sources | queries)
  </main>
</div>
```

### New sub-components (7 files created)

| # | File | Purpose |
|---|------|---------|
| 21 | `src/components/dashboard/ScoreBand.jsx` | 84px numeral, tier/trend badges, 3 hero stats, 40-seg meter, radial glow |
| 22 | `src/components/dashboard/OverviewView.jsx` | 4 KpiCards 2×2, "Where you're losing" (clickable→Answers), "What this means" (insight card) |
| 23 | `src/components/dashboard/AnswersView.jsx` | Master-detail: query list (filter chips) + transcript inspector (meta flags, branded text, citations) |
| 24 | `src/components/dashboard/RivalsView.jsx` | Stacked competitor cards: name, 30-seg ScoreMeter, "n text · n cited", gap badge |
| 25 | `src/components/dashboard/SourcesView.jsx` | 2 KPI cards + ranked domain list (mono index, type badges, 12-seg meters) |
| 26 | `src/components/dashboard/QueriesView.jsx` | Wraps QueryManager in flush Card |
| 27 | `src/components/dashboard/QueryManager.jsx` | **EDIT:** find-and-replace all hex colors → tokens. No logic changes. |

**View routing:** `view === "overview"` shows ScoreBand + OverviewView. Others show their respective views full-height.

---

## Phase 6 — Cleanup & Removals

### Step 6.1 — Delete 8 files

| # | File | Replaced by |
|---|------|-------------|
| 28 | `src/components/Navbar.jsx` | DossierLeftPanel + Sidebar |
| 29 | `src/components/Footer.jsx` | Inline footer in landing |
| 30 | `src/components/DashboardPreview.jsx` | Landing dossier modules |
| 31 | `src/components/dashboard/KpiCard.jsx` | perceev/KpiCard + perceev/HeroScoreCard |
| 32 | `src/components/dashboard/CompetitorTable.jsx` | RivalsView |
| 33 | `src/components/dashboard/CitationsPanel.jsx` | SourcesView |
| 34 | `src/components/dashboard/AioEvidence.jsx` | AnswersView |
| 35 | `src/components/dashboard/InsightPanel.jsx` | OverviewView "What this means" card |

### Step 6.2 — Keep (still referenced)

`ScoreBadge.jsx`, `QueryManager.jsx`, `ScoreBreakdown.jsx`, `TopPromptsTable.jsx`, etc. — check imports before deleting. All `src/components/ui/*` kept.

### Step 6.3 — Update imports in dashboard/page.js

Remove old imports (Navbar, KpiCard, CompetitorTable, InsightPanel, CitationsPanel, AioEvidenceList). Add new imports (Sidebar, Card, Badge, Button, Alert, ScoreMeter from perceev; ScoreBand, OverviewView, AnswersView, RivalsView, SourcesView, QueriesView from dashboard). Keep QueryManager, Skeleton, and all lib/service imports.

### Step 6.4 — Remove `design-system-incoming/` directory

```powershell
Remove-Item design-system-incoming -Recurse -Force
```

---

## Phase 7 — Full Verification

### Automated

```powershell
npm run test:scoring   # 67 tests, 0 failures (backend unchanged)
npm run lint           # clean, no import errors
npm run build          # succeeds, no prerender of scan worker
```

### Visual checklist (80 items)

**Landing (17 items):**
1-4. Page bg dark, left panel fixed, wordmark "perceev" with orange v, headline present
5-6. ScanBar input navigates to /scan, "Free · No signup" below
7-8. Probe counter ticks, module nav scrolls
9-12. Right stream 5 sections, AnswerDemo types with highlights, cycles 3 scenarios
13-15. Verdict 64/100 + meter, Rivalry meters, Method footnotes
16-17. Begin module with ScanBar + sample link, footer

**Scan (15 items):**
18-20. Dark theme, wordmark in top bar, "New scan" label
21-24. Perceev Input/Select components, validation errors, "Start scan" button
25-28. Scanning: caret text + stage rows + ScoreMeter progress
29-32. Redirect on success, Alert on fail, recent scans cards, click loads sample

**Dashboard — Overview (16 items):**
33-40. Sidebar (brand chip, nav, history, "New scan" button, status dot)
41-46. ScoreBand (84px score, tier/trend badges, stats, 40-seg meter)
47-48. KPI cards 2×2, "Where you're losing" + "What this means"

**Dashboard — Answers (10 items):**
49-55. Split layout, filter chips, query list, transcript inspector, highlights, empty state

**Dashboard — Rivals (4 items):**
56-58. Competitor cards, ScoreMeters, gap badges

**Dashboard — Sources (4 items):**
59-62. 2 KPI cards, ranked domain list, type badges, meters

**Dashboard — Queries (2 items):**
63-64. QueryManager dark theme, add/delete/toggle works

**Cross-cutting (16 items):**
65-80. Loading/empty/sample/banner states, scanning overlay, re-run, export, history click, data-testid preservation, Geist font active, no hex colors, shadcn compat, scrollbars, selection

---

## Complete File Manifest (35 operations)

| # | File | Action | Phase |
|---|------|--------|-------|
| 1 | `src/app/globals.css` | Overwrite | 1 |
| 2 | `tailwind.config.js` | Edit | 1 |
| 3 | `src/app/layout.js` | Edit (metadata) | 1 |
| 4-17 | `src/components/perceev/*` (14) | Create | 2 |
| 18-23 | `src/components/landing/*` (6) | Create | 3 |
| 24 | `src/app/page.js` | Overwrite | 3 |
| 25 | `src/app/scan/page.js` | Overwrite | 4 |
| 26 | `src/app/dashboard/page.js` | Overwrite | 5 |
| 27-32 | `src/components/dashboard/{ScoreBand,OverviewView,AnswersView,RivalsView,SourcesView,QueriesView}.jsx` (6) | Create | 5 |
| 33 | `src/components/dashboard/QueryManager.jsx` | Edit (restyle) | 5 |
| 34-41 | 8 old components | Delete | 6 |
| 42 | `design-system-incoming/` | Delete | 6 |
