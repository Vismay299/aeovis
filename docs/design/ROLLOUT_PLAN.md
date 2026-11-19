# UI rollout plan

> <!-- doc-status -->
> **Status: LIVE** — written 18 November 2026 by the PM role for the `dev`
> rollout of the locked UI in `docs/design/UI_LAB_DECISIONS.md`. This plan owns
> task order, ownership, acceptance and the data contracts. The visual spec is
> `UI_LAB_DECISIONS.md`; this document never overrides it.

## Scope

Roll the locked visual and motion system across the Perceev app on branch `dev`
without changing what the app does. Presentation only, except for the read-only
data exposure in the contracts below. No migrations, no new tables or columns,
no writes, no scoring, billing, spend-guard, auth or job-logic changes.

Unknown stays `null` to the screen and renders as an em dash. "Not measured",
"insufficient sample" and "measured zero" stay distinct. Simulated data stays
labelled.

## Owners

| Role | Owns |
| --- | --- |
| PM | This plan, scope decisions, acceptance, final report |
| FE lead | §3 branch/merge, shared layer, T1, T2, T11, review of every task |
| FE-1 | T3, T4 |
| FE-2 | T6, T7, T8, T10 |
| BE-1 | Read-only data for T2, T5, T9 engines |
| BE-2 | Read-only data for T8, T9 usage and daily counts |

Two roles never edit one file at once. Commit messages start with the role.

## Task ledger

Acceptance for every task: `npm run typecheck` clean, relevant tests green, the
affected route loads in the browser with no console or hydration errors, first
screen sharp, reduced-motion leaves everything visible, and no rejected item
(§5 of the brief) appears in changed code.

| ID | Task | Owner | State | Done means |
| --- | --- | --- | --- | --- |
| §3 | Merge `test_UI` into `dev` | FE lead | Done | `dev` has both sides' behaviour; typecheck, tests, lint run |
| T1 | Scroll reveal Rise → Focus | FE lead | Done | App-wide Rise rule gone; Focus is opt-in per list; first screen never blurred |
| T2 | Stat tiles → Spark | FE lead | Done | `Stat` renders `StatTile variant="spark"`; KpiRow passes a real series and delta; no fabricated series |
| T3 | Charts → Bklit Line / Bar | FE-1 | **Skipped** | See decision 1 |
| T4 | Loading states | FE-1 | Partial | Settings group loader added, recent-scans stagger added; in-card skeletons were already in place; in-button spinners left as the button's own busy state |
| T5 | Running scan visual + StatusIsland | FE lead | Done | `DotGridPulse` + `TextShimmer` stage label, rolling percentage, determinate bar kept, StatusIsland shows only the tracked scan |
| T6 | Hold / slide confirmations | FE-2 | Done | `ConfirmDialog` and both inline confirm paths hold for 1200 ms; `PricedActionButton` spends confirm by slider with the price in the label |
| T7 | Dialog emblems, morphing dialogs | FE-2 | Partial | Emblems on question edit, version approval and report share; morphing dialog not done (see decision 3) |
| T8 | Empty states, alerts, checklist | FE-2 | **Skipped** | See decision 2 |
| T9 | Usage and engines data cards | BE-1/BE-2 + FE lead | Partial | Monthly `LiquidGauge` wired from the existing usage `position`; `MetricCard` and `UptimeCard` need a read field that was not added |
| T10 | Public site | FE-2 | Done | Evidence card tilts, headline uses `TextEffect`, reduced motion swaps Tilt for a plain card, landing components import no `.tsx` |
| T11 | Sweep | FE lead | Done | No `framer-motion`, no hardcoded colours or `bg-white`/`text-black` in changed files, no rejected items |

## Decisions taken by the PM

1. **T3 skipped.** The chosen Bklit `LineChart` has no numeric Y axis at
   all — `XAxis` and `Grid` are the only axis primitives exported, and
   `BarYAxis` is a category axis for horizontal bars. `RankTrendChart` needs a
   reversed Google-position scale (1 = best, 1…`serpDepth`). Migrating it as
   drawn would either delete that axis or require editing the vendored chart
   internals, which rule 6 forbids; the concentration chart is a stacked area,
   and the chosen system has no area trend. The remaining files also mix in
   non-date x values (`yearWeek` like `2026-W32`, month labels), which the
   time-series shell would parse as dates. Shipping the migration would lose
   axis meaning, so the task is Skipped rather than half-done.
2. **T8 skipped.** The vendored Kokonut `EmptyState` is a project-creation
   playground with built-in sample projects and its own form; it cannot render
   the existing title/description/action without a rewrite that rule 6 forbids.
   `InlineAlert`'s "retry" is a local animation that flips failed checks to
   passed on a timer — wiring it to a real re-check would print a pass that was
   never observed. `OnboardingChecklist` is presentational only (completed
   flags, no actions, no skip/restore), so replacing the setup checklist would
   remove the buttons that run a scan, connect a tool or defer a step. All three
   are data-semantics violations, not style choices.
3. **T7 partial.** Emblems shipped. The row-to-detail morph needs the detail to
   live in the same component tree as the row; scan and question rows are table
   rows under `DataTable`, so a morph would mean restructuring those tables —
   outside "presentation only".
4. **T9 partial.** `brand_metrics_daily.prompts_mentioned` and
   `sov_state` are stored, but exposing them needs a new read field and a test
   (BE work), which was not added in this pass. The budget gauge needed no
   backend change because `GET /api/customer/usage` already returns
   `position.monthUsd` and `monthlyCapUsd`.

## Data contracts

Fields below are the exact shapes the frontend consumes. Unknown is `null`
everywhere; a missing point is absent, never `0`.

### T2 — visibility spark and delta

Source: `GET /api/customer/overview` (already returned, no backend change).

```
scans: Array<{
  id: string;
  visibility_pct: number | null;
  scanned_at: string | null;
  created_at: string;
}>                                   // newest first
```

Contract handed to `Stat`:

```
series: number[]                    // visibility %, OLDEST first, nulls dropped, ≥ 2 points or omitted
delta: { text: string; direction: "up" | "down" | "flat" }
sub: string                         // "since Oct 2" | "First scan" | "No scan yet"
```

### T5 — scan stage and progress

Source: `useScanTracker` / `GET /api/scan/[job_id]/status` (already returned).

```
stage: "pending" | "generating_prompts" | "probing" | "scoring" | "complete" | "failed"
stageLabel: string                  // from scanTrackerModel.js; reused, never re-typed
progress_pct: number | null         // determinate; null means unknown, not 0
```

StatusIsland shows only work the app already tracks: the running scan from
`usePortal().scan`. Exports are not tracked client-side (`POST
/api/customer/exports` is synchronous), so no export entry is shown.

### T8 — crawler checks and setup checklist

Crawler source: `GET /api/brands/[brand]/crawlability` (already returned).

```
fetched_ok: boolean;
robots_txt_status: "found" | "missing" | "error";
robots_malformed: boolean;
llms_txt_present: boolean | null;
fetch_error: string | null;
summary: { open: number; partial: number; blocked: number; total: number };
bots: Array<{ name, operator, platform, purpose, status, reason }>
```

Retry calls the existing refetch (`useAuditSummary().refetch()` on the audit
surface, `useCrawlerAccess().refetch()` on the dashboard surface). If neither is
mounted, `InlineAlert` renders without a retry.

Setup source: `GET /api/customer/setup`.

```
steps: Array<{ id: "questions"|"scan"|"gsc"|"audit"|"schedule"|"ga4"|"draft"|"team";
               status: "done" | "skipped" | "todo" }>
```

Labels, details and icons come from `src/shared/setup-steps.ts`. Completion
flags are computed server-side; the frontend counts, never recomputes.

### T9 — budget, daily mentions, engine status

Budget source: `GET /api/customer/usage` (already returned).

```
position: {
  monthUsd: number | null;
  monthlyCapUsd: number | null;     // null => no budget stored => LiquidGauge not rendered
  dailyCapUsd: number | null;
  todayUsd: number | null;
}
```

Daily mentions source: `brand_metrics_daily.prompts_mentioned` per
`(brand, date, engine)`, already stored. A read-only `dailyMentions` field on
`GET /api/customer/overview` is allowed:

```
dailyMentions: Array<{ date: string; mentioned: number | null }>  // oldest first, one row per day
```

Engine status source: `brand_metrics_daily.sov_state` per `(brand, date,
engine)` — `measured | measured_zero | not_assessed | failed`. Already stored. A
read-only field on the same route is allowed:

```
engines: Array<{ engine: string; days: Array<{ date: string; state: "measured"|"measured_zero"|"not_assessed"|"failed"|null }> }>
```

If either read field is not added, the corresponding card is **Skipped** and
listed in the report; the frontend does not derive it from a different table.

## Not covered by the locked list — left as is

- Any chart that is a ring, gauge or area trend: not chosen, so untouched.
- Shades, accents and the Edge / Pill shapes: open, switchable, not decided.
- Copy changes: none. Every conversion keeps the existing sentence.
