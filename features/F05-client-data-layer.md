# F05 — Client data layer and interaction patterns

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F05 |
| Wave | 0 |
| Comparison rows covered | "Frontend patterns worth taking": poll only while work runs at the server's pace; results fill in as they arrive; stale data stays visible when a refresh fails; prefetch on intent; URL-held filters; browser-like search tabs; recent searches |
| Depends on | F04 phases 1–4 merged (React 19, `@tanstack/react-query` installed, primitives, `QueryState`, `AppProviders`, app shell, `/api/customer/features`); F01 phase 1 (`zod`, `src/lib/http/errors.ts` envelope). Phase 3 also needs `fix/run-scan-unapproved-panel` merged (it migrates that branch's `useScanTracker.js` and Overview). |
| Blocks | F06; F09 phase 3; every later UI phase (F03 P4, F11 P3, F12 P3, F13…) |
| Reserved migrations | 060–064 — **unused** (F05 has no database objects) |
| Feature flag | none (infrastructure; behaviour of migrated surfaces is unchanged) |
| Spend features | none |
| OpenSEO reference | `openseo:src/client/tanstack-db/queryClient.ts`, `openseo:src/client/lib/error-messages.ts`, `openseo:src/client/components/QueryState.tsx`, `openseo:src/client/features/ai-visibility/shared.tsx`, `openseo:src/client/features/rank-tracking/{useRankRunPolling,useSetKeywordPinned}.ts`, `openseo:src/client/features/audit/AuditDetail.tsx`, `openseo:src/routes/_app/p/$projectId/saved.tsx`, `openseo:src/client/lib/filterSearchParams.ts`, `openseo:src/client/hooks/{useDebouncedDraft,useLocalHistoryStore,useTimestampedSearchHistory}.ts`, `openseo:src/client/features/search-tabs/*`, `openseo:src/client/components/RecentSearches.tsx` at `c5f8db1` |

## 1. Summary

One shared TanStack Query client, one typed JSON fetch helper and one query-key registry replace the hand-written `fetch` + `useEffect` loading code in the portal. Pages show cached data instantly, poll only while work is running and at the pace the server sets, keep the last good data on screen when a refresh fails, prefetch what the user is about to open, and keep filters in the URL. These are OpenSEO's client patterns; every later feature (keywords, rank tracking, explorer, history, reports) is built on them, and the existing portal context and scan tracker move onto them without changing what the customer sees.

## 2. What OpenSEO does (observed)

1. One `QueryClient`: `staleTime` 5 minutes ("show cached data instantly, refetch in background after"), `gcTime` 1 hour (`openseo:src/client/tanstack-db/queryClient.ts:25-30`).
2. A global `MutationCache.onError` toasts every failed mutation unless the mutation has its own `onError` or sets `meta: { errorToast: false }`, "so no failure is silent" (`queryClient.ts:5-24`); tested both ways (`openseo:src/client/tanstack-db/queryClient.test.ts:20-33`). Queries do not toast; pages render their errors.
3. Error copy: known error codes map to standard sentences; any other message passes through; non-`Error` values use the fallback (`openseo:src/client/lib/error-messages.ts:13-62`, tests `error-messages.test.ts:4-16`).
4. Out of credits is not retryable: `QueryError` renders `InsufficientCreditsError` instead of "Try again" (`openseo:src/client/components/QueryState.tsx:39-41`), which says how to get more credits and links to billing (`openseo:src/client/features/billing/InsufficientCreditsError.tsx:20-75`).
5. `QueryState` keeps loaded content visible when a refetch fails, with the error above it (`QueryState.tsx:53-87`).
6. **Server-paced polling.** A run query polls only while the run is `queued`/`running`, at `max(4, run.pollAfterSeconds)` seconds; a finished run has `staleTime: Infinity` and is never read again (`openseo:src/client/features/ai-visibility/shared.tsx:115-131`). While it runs, each new poll invalidates the answers it writes so they fill in; on finish it re-reads the tracker, which sees the finish and refreshes results itself; an already-finished run read on page open triggers nothing (`shared.tsx:132-157`, `:28-57`).
7. Other pacing: research setup polls every 3 s while running (`shared.tsx:59-65`); rank checks poll every 3 s while pending/running and every 30 s otherwise to discover scheduled runs, invalidating four result keys once per terminal run (`openseo:src/client/features/rank-tracking/useRankRunPolling.ts:9-47`); audits poll status every 3 s while running and fetch results only once completed or failed (`openseo:src/client/features/audit/AuditDetail.tsx:53-73`), with a live crawled-URL feed every 1.5 s (`AuditDetail.tsx:258-262`).
8. **Prefetch on intent.** The router preloads on intent (`openseo:src/router.tsx:45`), and route loaders start the page's queries without blocking navigation (`openseo:src/routes/_app/p/$projectId/ai-visibility.tsx:11-19`).
9. **Optimistic update.** `useSetKeywordPinned` cancels the results query, patches every cached compare period with `setQueriesData`, and on failure invalidates in `onSettled` (not `onError`, which would hide the global toast) (`openseo:src/client/features/rank-tracking/useSetKeywordPinned.ts:10-48`).
10. **Filters in the URL.** The saved-keywords route validates its search params with a schema and strips defaults (`openseo:src/routes/_app/p/$projectId/saved.tsx:63-77`). A form holds the typed draft; it reaches the URL after `FILTER_DEBOUNCE_MS = 350` with `replace: true` and the page reset (`saved.tsx:79`, `:133-153`); a ref stops the URL echo from resetting the form (`:121-131`). Numbers are stored as numbers, `include`/`exclude` as text (`openseo:src/client/lib/filterSearchParams.ts:1-49`). The same idea as a hook: `useDebouncedDraft(applied, commit, normalize, 350)` follows URL changes it did not cause (`openseo:src/client/hooks/useDebouncedDraft.ts:3-42`), used for list search (`openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx:70-72`).
11. **Per-viewer preferences** in `localStorage`, scoped per project when they depend on it, every access in `try/catch` (`openseo:src/client/features/keywords/hooks/usePreferredKeywordLocation.ts:8-71`; page size `openseo:src/client/features/keywords/page/KeywordResearchPagination.tsx:70-100`; filter defaults `openseo:src/client/features/domain/useDomainFilterPreferences.ts:12-67`).
12. **Search tabs.** Browser-like tabs of past searches per page: max 20, oldest evicted (`openseo:src/client/features/search-tabs/useSearchTabs.ts:30`, `:235-243`); stored in `sessionStorage["search-tabs:<key>"]` (`:141-143`, `:186-213`); stored state is re-validated and malformed tabs dropped (`:150-184`); opening an identical input re-activates its tab (`:259-283`); closing the active tab selects the right neighbour, else the left (`:298-327`); `viewedAt` tracks unseen results (`:329-344`). The strip shows a spinner while the tab's query fetches, a red dot on error and a primary dot when results arrived unseen, reading the cache with a disabled observer (`openseo:src/client/features/search-tabs/SearchTabStrip.tsx:104-171`). URL and tabs are kept in sync, and a just-closed tab is not reopened by the URL (`useSearchTabNavigation.ts:16-110`). Tests: `useSearchTabs.test.ts:29-211`.
13. **Recent searches.** `useLocalHistoryStore`: `localStorage`, newest first, de-duplicated, capped at 20, silent on storage errors (`openseo:src/client/hooks/useLocalHistoryStore.ts:3-88`); `useTimestampedSearchHistory` validates items with a zod JSON codec (`useTimestampedSearchHistory.ts:14-46`, `openseo:src/shared/json.ts:3-31`); `RecentSearches` renders the list with an empty state and a reveal-on-hover remove button (`openseo:src/client/components/RecentSearches.tsx:23-105`).

## 3. What Perceev has today

- No query library in use. Every page fetches in `useEffect` with a `live` flag and handles 401 itself.
- `src/components/portal/PortalShell.jsx`:
  - `refreshOverview` and `refreshGsc` fetch `/api/customer/overview` and `/api/customer/gsc` (`:157-186`); an effect calls both when the workspace changes (`:188-193`).
  - `setBrandKey` clears `overview` and `gsc` (`:150-155`). **Race:** `refreshOverview` writes its result after `await` without checking that the workspace is still the same, so a slow response for the previous workspace can overwrite the new one.
  - GSC errors settle to `{ connected: false, connection: null, error }` so no page waits forever (`:182-185`).
  - 401 → `router.replace("/login?next=<path>")` (`:75-76`).
- `src/components/portal/useScanTracker.js` (fix-branch version, 233 lines):
  - Resets on workspace change (`:66-76`); never re-adopts a job that finished or returned 404 (`settledJobIds`, `:57-59`).
  - Adopts a running job reported by the overview (`:78-95`).
  - Polls `GET /api/scan/<job>/status` every 2.5 s while active, with a `live` guard (`:100-155`). That route also re-fires stalled chunks, so polling is part of the P0 rescue path. It returns no `pollAfterSeconds`.
  - `start()` posts `{ brand_key }` and maps 401 / 409 `panel_not_approved` / 409 `scan_already_running` (`:157-196`). A late response after a workspace switch is not guarded.
  - Seven buttons call `scan.start`. Tests: lifecycle tests with a hand-rolled React (`portalRegressions.test.mjs` "a 404 scan is not re-adopted…", "a {terminal} scan is not re-adopted…", and on the fix branch the two 409 tests); `portalProgress.test.mjs` reads the source for the status URL and compiles the module for `scanStageIndex`, `SCAN_STAGES`, `ACTIVE_SCAN_STATUSES`.
- `src/app/portal/scans/[scanId]/page.jsx` fetches the report in an effect and keeps the previous report for the same scan while reloading (`:31-55`); its JSON download must stay the exact DTO (`portalRegressions.test.mjs` "R05 customer report download…").
- Overview (fix branch) reads the question panel with its own effect (`useApprovedPanel`).
- The scan report's question filters (tab, search, engine) are local state in `QuestionsCard` (`src/components/portal/scans/ReportCards.jsx:178-262`).
- Nothing uses URL-held filters, search tabs, recent searches or per-viewer preferences.
- F09 phase 3 will edit `useScanTracker.js`: `start()` opens a cost dialog; `confirmStart(maxUsd)` posts; new state `review`, `cancelReview()`, and a `priceReview` argument (`features/F09-price-before-running.md` §6.6.2). F05 must keep `start` and the return shape so those edits still apply.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F05-AC-01 | The shared client uses `staleTime` 300,000 ms and `gcTime` 3,600,000 ms; queries retry at most twice and never on 4xx; mutations never retry. A failed mutation without its own `onError` and without `meta.errorToast === false` shows exactly one toast with `describeError`; a 401 shows none. | unit `src/lib/query/queryClient.test.ts` |
| F05-AC-02 | `fetchJson` sends `cache: "no-store"` and `credentials: "same-origin"`, JSON headers only when there is a body, parses `{ error, code, recovery, details }` (and legacy `{ detail }`) into `ApiError`, maps network failures to `ApiError(0, "network_error")`, validates with an optional schema (`invalid_response` on mismatch), and calls the registered unauthorized handler on 401 before throwing. It reads only `status`, `ok` and `json()` from the response. | unit `src/lib/query/fetchJson.test.ts` |
| F05-AC-03 | Spend refusals (`feature_disabled`, `daily_cap`, `workspace_cap`, `over_approved_max`) render the spend card with the API message and recovery and no retry button; "View usage" appears only when the workspace has `usage_page` on. | unit `src/lib/query/errors.test.ts`; browser `F05-B06` |
| F05-AC-04 | Every query key comes from `src/lib/query/keys.ts`; workspace-scoped keys are `[domain, brandKey, …]`; `invalidateWorkspace` touches only that workspace's keys. | unit `src/lib/query/keys.test.ts` |
| F05-AC-05 | `pollIntervalMs` returns `false` when the data is not active and `max(floor, pollAfterSeconds ?? fallback) × 1000` when active; `useServerPacedQuery` uses `staleTime` 0 while active and `Infinity` when finished, and calls `onFinish` once per active→finished transition, never for data that was already finished when first read. | unit `src/lib/query/polling.test.ts` |
| F05-AC-06 | The optimistic helper patches every cached query matching the key before the request, invalidates on failure in `onSettled`, and leaves the global error toast in place. | unit `src/lib/query/optimistic.test.ts` |
| F05-AC-07 | URL state: params parse through a schema with defaults; writes strip defaults and empty values and use `replace`; text filters commit 350 ms after the last keystroke; a URL change the draft did not cause (back/forward, Clear filters) replaces the draft. | unit `src/lib/query/urlState.test.ts`, `filterSearchParams.test.ts`; browser `F05-B05` |
| F05-AC-08 | Per-viewer preferences read and write `localStorage` under `perceev:pref:<key>[:<brandKey>]`, validate with a schema, fall back on any error, and keep working in memory when storage throws. | unit `src/lib/query/localPrefs.test.ts` |
| F05-AC-09 | Search tabs: the same cases as OpenSEO's `useSearchTabs.test.ts` (eviction at 20, newest kept, malformed dropped, close selects right then left neighbour, re-opening an identical input re-activates), with storage in `sessionStorage["perceev:search-tabs:<feature>:<brandKey>"]`. | unit `src/lib/query/searchTabsState.test.ts` |
| F05-AC-10 | Recent searches: newest first, de-duplicated by the caller's rule, capped at 20, invalid stored JSON → empty list, storage errors ignored. | unit `src/lib/query/localHistory.test.ts` |
| F05-AC-11 | Portal context: overview, GSC and features come from queries keyed by workspace; after a switch the previous workspace's data is never shown, even when its response arrives late; `usePortal()` keeps every existing field and meaning. | unit `src/lib/query/portalQueries.test.ts`; browser `F05-B01` |
| F05-AC-12 | Scan tracker on queries: every existing lifecycle behaviour holds (404 and finished jobs never re-adopted; 409 `scan_already_running` adopts the next run; `panel_not_approved` is an error; workspace switch resets); a `start()` response that arrives after a workspace switch is ignored; `start` keeps a stable identity while `brandKey` and `starting` are unchanged. | unit `src/components/portal/scanTrackerModel.test.mjs`; existing `portalRegressions`/`portalProgress` tests |
| F05-AC-13 | The scan status route is polled every 2.5 s while a scan is active (the route sends no `pollAfterSeconds`, so the floor and fallback are 2.5 s, today's cadence) and not at all otherwise; the overview is refreshed once when the scan finishes. | unit `polling.test.ts`; browser `F05-B02` |
| F05-AC-14 | Hovering or focusing the Questions or Search Console sidebar item, or a scan row, prefetches that page's query once; opening it then renders from cache without a second request inside the stale time. | browser `F05-B03` |
| F05-AC-15 | Any 401 from a query or mutation sends the user to `/login?next=<current path and query>` exactly once. | browser `F05-B04` |

## 5. Scope

**In scope**
- `QueryClient` factory and provider; `fetchJson`; error helpers and the spend-refusal card; the key registry; `WorkspaceContext`.
- Helpers: server-paced polling (`useServerPacedQuery`, `useJobStatus` for F01 job routes), optimistic mutation, URL state (`useUrlSearchState`, `useDebouncedDraft`, `useDebouncedFilters`, filter param helpers), per-viewer preferences, search tabs (state, hooks, strip), recent searches (store, hooks, component), `PrefetchLink`.
- Migrations: `PortalShell.jsx` overview, GSC and features loading; `useScanTracker.js` (fix-branch version); Overview's approved-panel read; the scan report page's report query and URL-held question filters; prefetch in the sidebar and scan rows.
- A fake `@tanstack/react-query` module for the render-harness lifecycle tests.

**Out of scope**
- Changing any API route, including `/api/scan/<job>/status` (P0 rescue path; no `pollAfterSeconds` added).
- Tables, export (F06). The cost dialog and `confirmStart` (F09). Migrating the remaining page-level fetches (Scans list, Questions & evidence, Content Studio, Search Console page actions, Team): they keep their code until the feature that next changes them; new code must use F05.
- TanStack Router, TanStack DB, devtools.
- Deferred Mixed rows: Search Console and Teams behaviour unchanged (only how GSC status is loaded changes, with the same result).

## 6. Design

### 6.1 Data model

None. Migrations 060–064 stay unused.

### 6.2 Client modules

Pure modules live in `src/lib/query/` (relative imports with `.ts` extensions, conventions §5.3, so `node --test` runs them). React hooks and components live in `src/components/app/`.

#### `src/lib/query/fetchJson.ts`

```ts
export class ApiError extends Error {
  readonly status: number; readonly code: string; readonly recovery?: string; readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: { recovery?: string; details?: Record<string, unknown> });
}
export function isApiError(e: unknown): e is ApiError;
export type JsonSchema<T> = { parse(value: unknown): T };
export type FetchJsonInit<T> = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal; schema?: JsonSchema<T> };
export function setUnauthorizedHandler(fn: (() => void) | null): void;
export async function fetchJson<T = unknown>(url: string, init?: FetchJsonInit<T>, deps?: { fetch?: typeof fetch }): Promise<T>;
export function withBrand(path: string, brandKey: string, params?: Record<string, string | number | boolean | undefined | null>): string;
```

Rules:
1. Request: `headers: { Accept: "application/json" }` plus `Content-Type: application/json` and `JSON.stringify(body)` when `body !== undefined`; `cache: "no-store"`; `credentials: "same-origin"`.
2. A thrown `TypeError` from `fetch` → `ApiError(0, "network_error", "Could not reach Perceev. Check your connection and try again.")`. An `AbortError` is re-thrown unchanged (TanStack Query handles cancellation).
3. Body: `await response.json().catch(() => null)`.
4. `!response.ok`: `code = body?.code ?? (status === 401 ? "unauthenticated" : "http_" + status)`; `message = body?.error ?? body?.detail ?? "The request failed (" + status + ")."`; `recovery = body?.recovery`; `details = body?.details`. On 401 call the registered handler (if any) first. Throw.
5. `ok` with `schema`: `schema.parse(body)`; a throw becomes `ApiError(response.status, "invalid_response", "The server sent an unexpected response.")`. Never include the body in the error or a log.
6. `withBrand("/api/customer/overview", "acme", { range: "30d", x: undefined })` → `/api/customer/overview?brand_key=acme&range=30d` (undefined/null skipped, values URL-encoded, existing `?` respected).

#### `src/lib/query/errors.ts`

```ts
export const SPEND_REFUSAL_CODES = ["feature_disabled", "daily_cap", "workspace_cap", "over_approved_max"] as const;
export type SpendRefusalCode = (typeof SPEND_REFUSAL_CODES)[number];
export function isSpendRefused(e: unknown): e is ApiError & { code: SpendRefusalCode };
export function describeError(e: unknown, fallback?: string): string;
// ApiError → its message; Error with a message → message; else fallback ?? "Something went wrong. Please try again."
export function spendRefusedView(e: ApiError & { code: SpendRefusalCode }): { title: string; message: string; recovery: string | null; showUsageLink: boolean };
```

| Code | Title | Message | `showUsageLink` |
|---|---|---|---|
| `feature_disabled` | "Not available for this workspace" | API `error` ("This feature is not enabled for your workspace.") | false |
| `daily_cap` | "Daily spend limit reached" | API `error` | true |
| `workspace_cap` | "Monthly spend limit reached" | API `error` | true |
| `over_approved_max` | "The price changed" | API `error` | false |

`recovery` is the API's `recovery` or `null`. F04's `src/components/app/errors/describeError.ts` becomes `export { describeError } from "@/lib/query/errors";`.

#### `src/lib/query/keys.ts`

```ts
export const keys = {
  features:   (brandKey: string) => ["features", brandKey] as const,
  overview:   (brandKey: string) => ["overview", brandKey] as const,
  gsc:        (brandKey: string) => ["gsc", brandKey] as const,
  panel:      (brandKey: string, artifactKey = "default") => ["panel", brandKey, artifactKey] as const,
  scanStatus: (brandKey: string, jobId: string) => ["scanStatus", brandKey, jobId] as const,
  jobStatus:  (brandKey: string, jobId: string) => ["jobStatus", brandKey, jobId] as const,
  scanReport: (scanId: string) => ["scanReport", scanId] as const,
  usage:      (brandKey: string, range: string, tz: string) => ["usage", brandKey, range, tz] as const,   // F03
  price:      (brandKey: string, action: string, inputKey: string) => ["price", brandKey, action, inputKey] as const, // F09
} as const;
export const WORKSPACE_DOMAINS: ReadonlySet<string>;   // every domain above whose second element is a brandKey
export function isWorkspaceKey(key: readonly unknown[], brandKey: string): boolean;
export function invalidateWorkspace(client: { invalidateQueries(f: { predicate(q: { queryKey: readonly unknown[] }): boolean }): Promise<void> }, brandKey: string): Promise<void>;
export function stableStringify(value: unknown): string;   // sorted object keys; used for inputKey
```

Rule for later specs: a workspace-scoped key is `[domain, brandKey, ...params]`; a record addressed by an id the route authorises (`scanReport`) is `[domain, id]`. Each spec adds its entries here in its own PR.

#### `src/lib/query/queryClient.ts`

```ts
import { MutationCache, QueryClient } from "@tanstack/query-core";
declare module "@tanstack/query-core" { interface Register { mutationMeta: { errorToast?: false } } }
export const QUERY_STALE_TIME_MS = 300_000;
export const QUERY_GC_TIME_MS = 3_600_000;
export function shouldRetryQuery(failureCount: number, error: unknown): boolean; // false for ApiError 400–499; else failureCount < 2
export function createQueryClient(deps: { toastError(title: string, description?: string): void }): QueryClient;
```

`createQueryClient`: `new QueryClient({ mutationCache: new MutationCache({ onError(error, _v, _c, mutation) { if (isApiError(error) && error.status === 401) return; if (mutation.options.onError || mutation.meta?.errorToast === false) return; if (isSpendRefused(error)) { const v = spendRefusedView(error); deps.toastError(v.title, [v.message, v.recovery].filter(Boolean).join(" ")); return; } deps.toastError(describeError(error)); } }), defaultOptions: { queries: { staleTime: QUERY_STALE_TIME_MS, gcTime: QUERY_GC_TIME_MS, retry: shouldRetryQuery }, mutations: { retry: 0 } } })`. `refetchOnWindowFocus` keeps TanStack's default (true), as OpenSEO.

#### `src/lib/query/polling.ts`

```ts
export function pollIntervalMs<T>(data: T | undefined, o: { isActive(d: T): boolean; pollAfterSeconds?(d: T): number | null | undefined; floorSeconds?: number /* default 4 */; fallbackSeconds?: number /* default 5 */ }): number | false;
export function pacedStaleTime<T>(data: T | undefined, isActive: (d: T) => boolean): number; // 0 while active (or no data), Infinity when finished
export function finishTransition<T>(prev: T | undefined, next: T | undefined, o: { isActive(d: T): boolean; sameRun?(a: T, b: T): boolean }): boolean;
// true only when prev was active, next is not, and sameRun(prev, next) (default true)
export const JOB_ACTIVE_STATUSES: readonly ["queued", "running"];
export function isJobActive(s: { status: string } | undefined): boolean;
```

#### `src/lib/query/optimistic.ts`

```ts
export function optimisticHandlers<TVars, TCache>(client: QueryClient, queryKey: readonly unknown[], apply: (old: TCache, vars: TVars) => TCache): {
  onMutate(vars: TVars): Promise<void>;          // cancelQueries({ queryKey }); setQueriesData({ queryKey }, old => old === undefined ? old : apply(old, vars))
  onSettled(_d: unknown, error: unknown): void;  // if (error) void client.invalidateQueries({ queryKey })
};
```

#### `src/lib/query/filterSearchParams.ts` — COPY of `openseo:src/client/lib/filterSearchParams.ts` (`filterValuesFromSearch`, `filterValuesToSearch`, `normalizeFilterValues`), with `isTextField` taking an optional `textFields: readonly string[]` argument (default `["include", "exclude"]`).

#### `src/lib/query/urlState.ts`

```ts
export function parseSearchParams<S extends Record<string, unknown>>(params: URLSearchParams, schema: { safeParse(v: unknown): { success: boolean; data?: S } }, defaults: S, arrays?: readonly (keyof S)[]): S;
// Collect params (repeated keys → arrays for names in `arrays`), coerce numeric strings for keys whose default is a number, safeParse each key separately; an invalid value falls back to its default (so one bad param never resets the rest).
export function buildSearch<S extends Record<string, unknown>>(current: URLSearchParams, patch: Partial<S>, defaults: S): string;
// Apply patch; drop keys equal to their default, undefined, null, "" or []; keep unknown existing keys; sorted for stable URLs; returns "" or "?a=1&b=2".
```

#### `src/lib/query/localPrefs.ts`

```ts
export function prefStorageKey(key: string, brandKey?: string): string; // "perceev:pref:<key>" or "perceev:pref:<key>:<brandKey>"
export function readPref<T>(storage: Storage | null, fullKey: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }, fallback: T): T;
export function writePref(storage: Storage | null, fullKey: string, value: unknown): boolean; // false when storage throws or is null
```

#### `src/lib/query/searchTabsState.ts` (PORT of `useSearchTabs.ts:13-250`, generic over the input type)

```ts
export const SEARCH_TABS_LIMIT = 20;
export type SearchTab<I> = { id: string; label: string; input: I; createdAt: number; viewedAt: number | null };
export type TabsState<I> = { tabs: SearchTab<I>[]; activeTabId: string | null };
export const EMPTY_TABS: TabsState<never>;
export function searchTabsStorageKey(feature: string, brandKey: string): string;   // "perceev:search-tabs:<feature>:<brandKey>"
export function tabInputKey(input: unknown): string;                               // stableStringify
export function parseStoredState<I>(value: unknown, parseInput: (raw: unknown) => I | null): TabsState<I>;
export function appendTabWithEviction<I>(tabs: SearchTab<I>[], next: SearchTab<I>): SearchTab<I>[];
export function openTabState<I>(s: TabsState<I>, o: { label: string; input: I; id: string; now: number }): TabsState<I>;
export function setActiveState<I>(s: TabsState<I>, tabId: string | null): TabsState<I>;
export function closeTabState<I>(s: TabsState<I>, tabId: string): { state: TabsState<I>; closedActive: boolean; nextActiveTab: SearchTab<I> | null };
export function markViewedState<I>(s: TabsState<I>, tabId: string, when: number): TabsState<I>;
```

Each function returns the same object when nothing changes (as OpenSEO's `update` relies on).

#### `src/lib/query/localHistory.ts` (PORT of `useLocalHistoryStore.ts:12-34` and `:57-85`)

```ts
export const HISTORY_LIMIT = 20;
export function historyStorageKey(feature: string, brandKey: string): string; // "perceev:recent:<feature>:<brandKey>"
export function loadHistory<T>(storage: Storage | null, key: string, parse: (raw: string) => T[] | null, max?: number): T[];
export function addHistoryItem<T, A>(items: T[], input: A, o: { isSame(a: T, b: A): boolean; create(a: A): T; max?: number }): T[];
export function removeHistoryItem<T>(items: T[], itemKey: number, getKey: (t: T) => number): T[];
export function saveHistory(storage: Storage | null, key: string, items: unknown[]): void;
```

`src/shared/json.ts`: COPY of `openseo:src/shared/json.ts` (`jsonCodec`, zod v4 `z.codec`).

#### `src/lib/query/portalQueries.ts` (query option builders for portal data; plain objects so they are unit-testable)

```ts
export function featuresQueryOptions(brandKey: string);   // key keys.features, GET /api/customer/features?brand_key=
export function overviewQueryOptions(brandKey: string);   // key keys.overview, GET /api/customer/overview?brand_key=
export function gscQueryOptions(brandKey: string);        // key keys.gsc, GET /api/customer/gsc?brand_key=
export function panelQueryOptions(brandKey: string);      // key keys.panel, GET /api/customer/repairs/panel?brand_key=, staleTime 0
export function scanReportQueryOptions(scanId: string);   // key keys.scanReport, GET /api/customer/scan/report/<encoded id>
```

Each returns `{ queryKey, queryFn: ({ signal }) => fetchJson(url, { signal }), enabled: Boolean(id) }` and **never** sets `placeholderData` (a workspace switch must not show the previous workspace's data).

#### React layer (`src/components/app/`)

| File | Exports |
|---|---|
| `providers/queryClient.ts` | `getQueryClient(): QueryClient` — on the server a new client per call; in the browser one singleton created with `toastError: (t, d) => toast.error(t, d ? { description: d } : undefined)` (sonner). |
| `providers/AppProviders.tsx` (F04 file, edited) | wraps `TooltipProvider` in `<QueryClientProvider client={useState(getQueryClient)[0]}>`. |
| `workspace/WorkspaceContext.tsx` | `WorkspaceContext`, `WorkspaceProvider({ value: { brandKey: string; features: Record<string, boolean> \| null; isOwner: boolean }, children })`, `useWorkspace(): … \| null` — lets TSX feature components read the workspace without importing portal JSX. |
| `SpendRefusedError.tsx` | `SpendRefusedError({ error, variant?, title? })` → `ErrorState` with `title = view.title`, `message = view.message` + recovery sentence, `action` = `Button variant="outline" size="sm" className="text-foreground" render={<Link href="/portal/usage" />}` "View usage" when `view.showUsageLink && useWorkspace()?.features?.usage_page === true`, else no button (PORT of `InsufficientCreditsError.tsx:20-36`, `:77-90`). |
| `QueryState.tsx` (F04 file, edited) | `QueryError`: when `isSpendRefused(error ?? cause)` render `SpendRefusedError`; otherwise unchanged; `describeError` from `@/lib/query/errors`. |
| `hooks/useServerPacedQuery.ts` | `useServerPacedQuery<T>(options & { isActive(d: T): boolean; pollAfterSeconds?(d: T): number \| null \| undefined; floorSeconds?: number; fallbackSeconds?: number; sameRun?(a: T, b: T): boolean; onFinish?(d: T): void })` → `useQuery` with `refetchInterval: q => pollIntervalMs(q.state.data, …)`, `refetchIntervalInBackground: false`, `staleTime: q => pacedStaleTime(q.state.data, isActive)`, and an effect calling `onFinish` when `finishTransition(prev, data)` (PORT of `shared.tsx:115-157`). |
| `hooks/useJobStatus.ts` | `useJobStatus(brandKey, jobId, { onFinish? })` → `useServerPacedQuery` on `keys.jobStatus`, `GET /api/customer/jobs/<jobId>?brand_key=` (F01 §6.5), `isActive = isJobActive`, `pollAfterSeconds = d => d.pollAfterSeconds`, floor 4, fallback 5. |
| `hooks/useOptimisticMutation.ts` | `useOptimisticMutation<TVars, TData, TCache>({ mutationFn, queryKey, apply, onSuccess?, meta? })` using `optimisticHandlers`. |
| `hooks/useUrlSearchState.ts` | `useUrlSearchState<S>(schema, defaults, { arrays? })` → `[state: S, set(patch: Partial<S>, o?: { replace?: boolean /* default true */ }): void]` using `useSearchParams`, `usePathname`, `useRouter().replace/push(pathname + buildSearch(...), { scroll: false })`. |
| `hooks/useDebouncedDraft.ts` | COPY (`delayMs = 350`). |
| `hooks/useDebouncedFilters.ts` | `useDebouncedFilters<V extends Record<string, string>>({ applied: V, empty: V, commit(values: V): void, delayMs?: 350, textFields? })` → `{ draft: V, setField(k, v), reset(), activeCount }`; PORT of `saved.tsx:111-153` (draft → URL after 350 ms with the page param cleared by the caller's `commit`; the awaiting-write ref). |
| `hooks/useLocalPref.ts` | `useLocalPref<T>(key, schema, fallback, { brandKey? })` → `[T, (v: T) => void]` with `useSyncExternalStore` over `storage` and a `perceev:pref-change` event; in-memory value when `writePref` returns false. |
| `search-tabs/useSearchTabs.ts`, `search-tabs/useSearchTabNavigation.ts`, `search-tabs/SearchTabStrip.tsx` | PORT of OpenSEO's three files on `searchTabsState.ts`; `useSearchTabs(feature, brandKey, parseInput)`; `SearchTabStrip<I>({ tabs, activeTabId, onSelect, onClose, onViewed, getQueryConfig(tab): { queryKey; staleTime?; gcTime? } })` reads status with a disabled observer (`enabled: false, select: () => null, notifyOnChangeProps: ["dataUpdatedAt","fetchStatus","status"]`). Feature-specific input types and query configs stay in the features (F11, F13, F14, F16). |
| `hooks/useLocalHistoryStore.ts`, `hooks/useTimestampedSearchHistory.ts`, `RecentSearches.tsx` | PORT/COPY on `localHistory.ts` and `src/shared/json.ts`; keys from `historyStorageKey(feature, brandKey)`. |
| `PrefetchLink.tsx` | `PrefetchLink({ href, prefetch?: () => FetchQueryOptions, …LinkProps })` → Next `Link`; on first `mouseenter`, `focus` or `touchstart` calls `queryClient.prefetchQuery(prefetch())` (one call per mount). |

Navigation items (F04 registry) gain an optional field `prefetch?: (brandKey: string) => unknown` (typed in `navModel.ts` as `unknown`, cast by `AppSidebar`): Overview → `overviewQueryOptions`, Questions → `panelQueryOptions`, Search Console → `gscQueryOptions`. `AppSidebar` renders items through `PrefetchLink`.

### 6.3 Portal migration

#### `PortalShell.jsx`

- Keeps boot (Supabase user, invites, memberships), `brands`, `brandKey`, `setBrandKey`, `isOwner`, `signOut`, `redirectToLogin` exactly.
- `useEffect(() => { setUnauthorizedHandler(() => redirectOnce()); return () => setUnauthorizedHandler(null); }, [...])` where `redirectOnce` sets a ref and calls `router.replace("/login?next=" + encodeURIComponent(location.pathname + location.search))` only the first time.
- Queries (enabled when `phase === "ready" && brandKey`): `useQuery(featuresQueryOptions(brandKey))`, `useQuery(overviewQueryOptions(brandKey))`, `useQuery(gscQueryOptions(brandKey))`.
- Context fields keep their meaning:
  - `overview = overviewQuery.data ?? null`
  - `overviewLoading = overviewQuery.isFetching`
  - `overviewError = overviewQuery.isError ? describeError(overviewQuery.error, "Could not load your workspace.") : ""`
  - `refreshOverview = () => queryClient.invalidateQueries({ queryKey: keys.overview(brandKey) })`
  - `gsc = gscQuery.isError ? { connected: false, connection: null, error: describeError(gscQuery.error, "Could not read your Search Console connection.") } : gscQuery.data ?? null`
  - `refreshGsc = () => queryClient.invalidateQueries({ queryKey: keys.gsc(brandKey) })`
  - `features = featuresQuery.data?.features ?? null` (replaces F04's plain fetch).
- Removes the old `refreshOverview`/`refreshGsc` effects and state.
- Wraps children in `WorkspaceProvider value={{ brandKey, features, isOwner }}`.
- `useScanTracker({ brandKey, jobs: overview?.scan_jobs, onFinished: refreshOverview, onUnauthorized: redirectToLogin })` unchanged.

#### `src/components/portal/scanTrackerModel.js` (new, pure JS; imports `../../lib/scanProgress.js` relatively)

Moves out of the hook: `ACTIVE_SCAN_STATUSES`, `PANEL_NOT_APPROVED`, `SCAN_ALREADY_RUNNING`, `SCAN_STAGES`, `scanStageIndex`, `SCAN_STALL_MS`, plus:

```js
export const SCAN_POLL_SECONDS = 2.5;
export function initialTrackerState(brandKey) // { brandKey, job: null, progress: initialScanProgress(), quietMs: null, finished: null, starting: false, error: "", errorCode: null, notice: "", settledJobIds: [], notifySeq: 0 }
export function scanTrackerReducer(state, action)
export function trackerView(state) // { job, active, percent, stageIndex, stage, reconnecting, stalled, finished, starting, error, errorCode, notice } — same fields and meanings as today's return value (useScanTracker.js:211-232)
```

| Action | Effect (same rules as today's code, cited) |
|---|---|
| `{ type: "brandChanged", brandKey }` | `initialTrackerState(brandKey)` (`:66-76`) |
| `{ type: "jobsSeen", jobs }` | if no active job: adopt the first job in `ACTIVE_SCAN_STATUSES` not in `settledJobIds`, with `applyScanReading(beginScanProgress(), …)` (`:78-95`) |
| `{ type: "statusReceived", jobId, httpStatus, ok, body }` | ignored unless `jobId === state.job?.id`; 404 → settle and clear (`:109-116`); `!ok`, no body, `transient_error` or `status === "unknown"` → `applyScanUnknown` (`:119-121`); `complete` → settle, `finished = { status: "complete", jobId, resultId, terminal_outcome, at }`, `notifySeq + 1` (`:123-130`); `failed` → settle, `finished = { status: "failed", … }`, `notifySeq + 1` (`:131-137`); else status/progress update and `quietMs` (`:122`, `:138-141`) |
| `{ type: "statusNetworkError", jobId }` | `applyScanUnknown(prev, { reason: "network" })` (`:143-146`) |
| `{ type: "startRequested" }` | `starting = true`; clear `error`, `errorCode`, `notice`, `finished` (`:159-163`) |
| `{ type: "startResolved", brandKey, outcome }` | ignored when `brandKey !== state.brandKey` (new guard); `outcome.kind`: `"started"` → job `{ id, status: "pending", created_at }`, `beginScanProgress()`, `notifySeq + 1` (`:187-190`); `"panelNotApproved"` → `errorCode = PANEL_NOT_APPROVED`, `error` = today's sentence (`:175-179`); `"alreadyRunning"` → `notice` = today's sentence, `notifySeq + 1` (`:180-185`); `"unauthorized"` → nothing (`:170-173`); `"error"` → `error = message` (`:186`, `:191-193`); always `starting = false` |
| `{ type: "dismissed" }` | as `dismiss` (`:198-207`) |

The reducer returns the **same state object** when an action changes nothing (for example `jobsSeen` while a job is already active), so effects that depend on `state.job` settle instead of looping (the lifecycle test fails on a render loop after 50 passes).

#### `src/components/portal/useScanTracker.js` (rewritten on the model)

```js
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pollIntervalMs } from "@/lib/query/polling";
import { keys } from "@/lib/query/keys";
import { ACTIVE_SCAN_STATUSES, SCAN_POLL_SECONDS, initialTrackerState, scanTrackerReducer, trackerView } from "./scanTrackerModel";
export { ACTIVE_SCAN_STATUSES, PANEL_NOT_APPROVED, SCAN_ALREADY_RUNNING, SCAN_STAGES, scanStageIndex, SCAN_STALL_MS } from "./scanTrackerModel";

export function useScanTracker({ brandKey, jobs, onFinished, onUnauthorized }) { … }
```

- State: `const [state, setState] = useState(() => initialTrackerState(brandKey)); const dispatch = useCallback((a) => setState((s) => scanTrackerReducer(s, a)), []);` (`useState`, not `useReducer`, because the lifecycle test React has no `useReducer`).
- `useEffect(() => dispatch({ type: "brandChanged", brandKey }), [brandKey, dispatch])`; `useEffect(() => dispatch({ type: "jobsSeen", jobs: jobs || [] }), [jobs, state.job, dispatch])`.
- Status query: `useQuery({ queryKey: keys.scanStatus(brandKey || "none", jobId || "none"), queryFn: async ({ signal }) => { const response = await fetch(\`/api/scan/${encodeURIComponent(jobId)}/status\`, { cache: "no-store", signal }); const body = await response.json().catch(() => null); return { jobId, httpStatus: response.status, ok: response.ok, body }; }, enabled: Boolean(brandKey && jobId && active), refetchInterval: () => (activeRef.current ? pollIntervalMs({}, { isActive: () => true, floorSeconds: SCAN_POLL_SECONDS, fallbackSeconds: SCAN_POLL_SECONDS }) : false), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false })`. The URL template literal stays exactly as today (asserted by `portalProgress.test.mjs`). Raw `fetch` is kept here (not `fetchJson`) because the reducer interprets 404, transient and `{ detail }` bodies itself.
- `useEffect` on `statusQuery.dataUpdatedAt` → `dispatch({ type: "statusReceived", ...statusQuery.data })`; on `statusQuery.errorUpdatedAt` → `dispatch({ type: "statusNetworkError", jobId })`.
- `useEffect` on `state.notifySeq` (skipping 0) → `onFinishedRef.current?.()`.
- `postStart(maxUsd)`: `const requestedFor = brandKey; dispatch({ type: "startRequested" }); …` POST `/api/customer/scan` with `{ brand_key: requestedFor }` (plus `maxUsd` when defined — F09 sends it; F05 never passes it), map the response to an outcome exactly as `:170-186`, then `if (brandRef.current !== requestedFor) return;` before dispatching `startResolved`; call `onUnauthorizedRef.current?.()` on 401.
- `start = useCallback(() => { if (!brandKey || state.starting) return; return postStart(undefined); }, [brandKey, state.starting, postStart])`. F09 changes only `start` and renames/exports `postStart` as `confirmStart`.
- Return `{ ...trackerView(state), start, dismiss }` — the same fields as today.

#### Overview approved panel (`src/app/portal/page.jsx`, fix-branch version)

`useApprovedPanel(brandKey)` becomes `useQuery({ ...panelQueryOptions(brandKey), select: (body) => Array.isArray(body?.items) ? body.items.some((p) => p.artifact_key === "default" && p.state === "approved") : null })`, returning `query.isError ? null : query.data ?? null` (same three-valued result as today; `staleTime: 0` so approving on Questions & evidence is seen on return).

#### Scan report (`src/app/portal/scans/[scanId]/page.jsx`)

- `const query = useQuery(scanReportQueryOptions(scanId))`.
- State mapping: `!scanId` or `isApiError(query.error) && query.error.status === 404` → today's "Scan not found" view; `query.isPending` → today's loading skeletons; `query.isError` with data → banner above the report; without data → "Report did not load" banner with "Retry" → `query.refetch()`.
- `report = query.data ?? null`; `downloadMeasurement` unchanged (same DTO).
- Question filters in the URL: `const [filters, setFilters] = useUrlSearchState(questionFiltersSchema, { view: "all", q: "", engine: "all" })` with `questionFiltersSchema = z.object({ view: z.enum(["all", "naming", "missing", "unanswered"]), q: z.string().max(200), engine: z.string().max(40) })`; `const [search, setSearch] = useDebouncedDraft(filters.q, (q) => setFilters({ q }))`; pass `filters={{ view: filters.view, search, engine: filters.engine }}` and `onFiltersChange={(p) => { if ("search" in p) setSearch(p.search); else setFilters({ view: p.view ?? filters.view, engine: p.engine ?? filters.engine }); }}` to `QuestionsCard`.
- `QuestionsCard` (`ReportCards.jsx`) gains optional props `filters` and `onFiltersChange`: when given, it uses them instead of its three `useState`s; "Clear filters" calls `onFiltersChange({ view: "all", engine: "all" })` and `onFiltersChange({ search: "" })`. Without the props it behaves exactly as today (all existing render tests pass it no props).
- Scan rows on `/portal/scans` and in Overview's `RecentScans` use `PrefetchLink` with `prefetch={() => scanReportQueryOptions(scan.id)}`.

### 6.4 Provider calls and cost

None.

### 6.5 API routes

None new or changed. Consumed: `/api/customer/{features,overview,gsc,repairs/panel,scan/report/[scan_id]}`, `/api/scan/[job_id]/status` (unchanged), `/api/customer/jobs/[jobId]` (F01).

### 6.6 UI

No visual change, except:
- **Spend refusal card** (`SpendRefusedError`): `ErrorState variant="card"` with the title and message of §6.2 table, the recovery sentence appended, and "View usage" when allowed. No "Try again".
- **Mutation error toasts**: sonner `toast.error(title, { description })`, bottom-right (F04 `AppToaster`).
- **Scan report URL**: `/portal/scans/<id>?view=missing&q=pricing&engine=chatgpt` reproduces the filtered view; defaults never appear in the URL.
- **Search tabs strip** (for F11/F13/F14/F16): `rounded-xl border border-border bg-card p-1`, `role="tablist" aria-label="Search tabs"`, tab buttons `role="tab" aria-selected`, label `max-w-[10rem] truncate`, close button `aria-label="Close {label} tab"`; status dot: spinner while fetching, `bg-destructive` dot on error, `bg-primary` dot for unseen results; hidden when there are no tabs (`SearchTabStrip.tsx:37-102`). Phone: the strip scrolls horizontally inside itself.
- **Recent searches** (for features): header "{n} recent search(es)" with a History icon; rows with a Clock icon, title, subtitle, short date (`month: "short", day: "numeric"`) and a reveal-on-hover remove button `aria-label="Remove from recent searches"`; empty state from the feature (`RecentSearches.tsx:23-105`).

### 6.7 Permissions, privacy, observability

- `fetchJson` never logs request or response bodies; `ApiError` carries only the server's public `error`, `code`, `recovery` and `details`.
- Per-viewer preferences, search tabs and recent searches stay in the browser (`localStorage` / `sessionStorage`), keyed by workspace; they hold search inputs the user typed, never API results.
- PostHog events: none in F05 (F26 can add `ui:search_tab_opened` later).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/client/tanstack-db/queryClient.ts` (+ `queryClient.test.ts`) | `src/lib/query/queryClient.ts` (+ `queryClient.test.ts`) | PORT | Factory with injected toast; 401 and spend-refusal branches; retry rule; mutations never retry. |
| `openseo:src/client/lib/error-messages.ts` (+ test) | `src/lib/query/errors.ts` (+ `errors.test.ts`) | PORT | Our routes send human messages, so the message wins; codes drive the spend card. |
| `openseo:src/client/components/QueryState.tsx:39-41`, `openseo:src/client/features/billing/InsufficientCreditsError.tsx:20-90` | `src/components/app/QueryState.tsx` (edit), `src/components/app/SpendRefusedError.tsx` | PORT | Credits → spend caps; link to Usage instead of Billing. |
| `openseo:src/client/features/ai-visibility/shared.tsx:115-157` | `src/lib/query/polling.ts`, `src/components/app/hooks/useServerPacedQuery.ts` | PORT | Generic over the run shape; floor/fallback configurable. |
| `openseo:src/client/features/rank-tracking/useRankRunPolling.ts:9-47` | `useServerPacedQuery` `onFinish` | PATTERN | One invalidation per terminal transition. |
| `openseo:src/client/features/audit/AuditDetail.tsx:53-73,258-262` | `useJobStatus` | PATTERN | Results fetched only after finish; live feeds poll a separate key. |
| `openseo:src/router.tsx:45`, `openseo:src/routes/_app/p/$projectId/ai-visibility.tsx:11-19` | `src/components/app/PrefetchLink.tsx`, nav `prefetch` | PATTERN | Next `Link` + `prefetchQuery` on intent. |
| `openseo:src/client/features/rank-tracking/useSetKeywordPinned.ts:10-48` | `src/lib/query/optimistic.ts`, `src/components/app/hooks/useOptimisticMutation.ts` | PORT | Generic `apply`. |
| `openseo:src/client/lib/filterSearchParams.ts` | `src/lib/query/filterSearchParams.ts` | COPY | Text fields configurable. |
| `openseo:src/routes/_app/p/$projectId/saved.tsx:63-153` | `src/lib/query/urlState.ts`, `src/components/app/hooks/{useUrlSearchState,useDebouncedFilters}.ts` | PORT | Next `useSearchParams`/`router.replace`; default stripping as `stripSearchParams`. |
| `openseo:src/client/hooks/useDebouncedDraft.ts` | `src/components/app/hooks/useDebouncedDraft.ts` | COPY | — |
| `openseo:src/client/features/keywords/hooks/usePreferredKeywordLocation.ts`, `openseo:src/client/features/keywords/page/KeywordResearchPagination.tsx:70-100` | `src/lib/query/localPrefs.ts`, `src/components/app/hooks/useLocalPref.ts` | PATTERN | One generic hook. |
| `openseo:src/client/features/search-tabs/useSearchTabs.ts` (+ test) | `src/lib/query/searchTabsState.ts` (+ test), `src/components/app/search-tabs/useSearchTabs.ts` | PORT | Generic input type; storage key per feature and workspace. |
| `openseo:src/client/features/search-tabs/useSearchTabNavigation.ts` | `src/components/app/search-tabs/useSearchTabNavigation.ts` | COPY | — |
| `openseo:src/client/features/search-tabs/SearchTabStrip.tsx` | `src/components/app/search-tabs/SearchTabStrip.tsx` | PORT | `getQueryConfig` passed in instead of hard-coded features. |
| `openseo:src/client/hooks/useLocalHistoryStore.ts`, `useTimestampedSearchHistory.ts` | `src/lib/query/localHistory.ts`, `src/components/app/hooks/{useLocalHistoryStore,useTimestampedSearchHistory}.ts` | PORT | Pure core extracted for tests. |
| `openseo:src/shared/json.ts` | `src/shared/json.ts` | COPY | — |
| `openseo:src/client/components/RecentSearches.tsx` | `src/components/app/RecentSearches.tsx` | COPY | — |

## 8. Implementation plan

Branches `feat/f05-client-data-layer-p<N>`.

### Phase 1 — Query foundation

**Goal:** the shared client, fetch helper, keys, errors and spend card exist and are tested; the provider is mounted; nothing else changes.

- [x] **P1.T1 Dependencies**
  - [x] **P1.T1.S1** *Files:* `package.json`, `package-lock.json`. *Do:* `npm install @tanstack/query-core@^5.103.2` (same version as the `@tanstack/react-query` F04 installed). *Verify:* `node -e "import('@tanstack/query-core').then(m=>console.log(typeof m.QueryClient))"` → `function`.
- [x] **P1.T2 Pure modules**
  - [x] **P1.T2.S1** *Files:* `src/lib/query/fetchJson.ts`, `src/lib/query/fetchJson.test.ts`. *Do:* §6.2; tests with an injected `fetch` returning `{ status, ok, json }` objects: 200 JSON → value; 200 empty body → `null`; schema mismatch → `invalid_response`; 400 `{error,code,details}` → `ApiError` fields; legacy `{detail}` → message; 401 → handler called once then `ApiError(401,"unauthenticated")`; `TypeError` → `network_error`; `AbortError` re-thrown; POST sets `Content-Type` and body, GET does not; `withBrand` cases. *Verify:* `node --test src/lib/query/fetchJson.test.ts` → pass (F05-AC-02).
  - [x] **P1.T2.S2** *Files:* `src/lib/query/errors.ts`, `errors.test.ts`. *Do:* §6.2 table; `describeError` cases. *Verify:* `node --test src/lib/query/errors.test.ts` → pass (F05-AC-03 unit).
  - [x] **P1.T2.S3** *Files:* `src/lib/query/keys.ts`, `keys.test.ts`. *Do:* §6.2; tests: every builder's shape; `isWorkspaceKey(["overview","a"],"a")` true, `(["overview","b"],"a")` false, `(["scanReport","x"],"x")` false; `invalidateWorkspace` with a recording client calls the predicate and matches only `a` keys; `stableStringify({b:1,a:{d:1,c:2}})` → `{"a":{"c":2,"d":1},"b":1}`. *Verify:* `node --test src/lib/query/keys.test.ts` → pass (F05-AC-04).
  - [x] **P1.T2.S4** *Files:* `src/lib/query/queryClient.ts`, `queryClient.test.ts`. *Do:* PORT of OpenSEO's two cases plus: 401 → no toast; spend refusal → toast with the card title and message; defaults equal the constants; `shouldRetryQuery(0, new ApiError(404,…))` false, `(1, new ApiError(500,…))` true, `(2, …)` false; mutation `retry` 0. Build failing mutations with `client.getMutationCache().build(client, {...}).execute(undefined).catch(() => {})` as OpenSEO does. *Verify:* `node --test src/lib/query/queryClient.test.ts` → pass (F05-AC-01).
- [x] **P1.T3 React layer**
  - [x] **P1.T3.S1** *Files:* `src/components/app/providers/queryClient.ts`, `src/components/app/providers/AppProviders.tsx`, `src/components/app/workspace/WorkspaceContext.tsx`, `src/components/app/SpendRefusedError.tsx`, `src/components/app/QueryState.tsx`, `src/components/app/errors/describeError.ts`. *Do:* §6.2 React table. *Verify:* `npm run typecheck` → exit 0; `npm run build` → exit 0.
  - [x] **P1.T3.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* append this phase's COPY/PORT paths. *Verify:* `git grep -c "tanstack-db/queryClient.ts" -- THIRD_PARTY_NOTICES.md` → `1`.

**Checkpoint:** `npm test`, `npm run typecheck`, `npm run build`, `check-f04-browser.mjs` → pass (providers do not change rendering). Completes F05-AC-01, -02, -04, unit half of -03.

**Phase 1 notes (deviations from the text above, reviewed and accepted by the CTO):**

- P1.T1.S1 installs `@tanstack/query-core@5.104.5` (recorded as `^5.104.5`), not `^5.103.2`: `^` resolved the newest 5.106.1 and left two copies, because `@tanstack/react-query` pins 5.104.5 exactly. One copy is what "same version as react-query" needs. Bump `@tanstack/react-query` and `@tanstack/query-core` together and run `npm ls @tanstack/query-core`.
- §6.2 cites "conventions §5.3" for relative `.ts` imports; the rule is in `00-CONVENTIONS.md` §5.4.
- `describeError` returns the fallback for anything that is not an `Error` with a message, so a thrown string no longer shows as-is (F04's version did); `fallback` is now optional.
- `SpendRefusedError`: the card title is always `view.title` (the `title?` prop stays for `QueryError` parity but is unused for spend cards).
- `SpendRefusedError`'s "View usage" `Button` takes `nativeButton={false}` as well as `render=`, as the repo's base-ui Button requires.
- `queryClient.test.ts` case 1 (ported from OpenSEO) asserts the message is toasted verbatim, exactly once, because Perceev has no error-code table (§7: the message wins); `vi.mock("sonner")` is replaced by the injected `toastError`.
- `fetchJson` ignores non-string `error`/`detail`/`code`/`recovery` and non-object `details` in an error body, and rethrows fetch failures that are neither `TypeError` nor `AbortError` unchanged.
- Review fixes (PR #45):
  - `@tanstack/query-core` and `@tanstack/react-query` are both pinned to exactly `5.104.5` (no `^`), so neither can drift into a second copy. Bump them together.
  - `shouldRetryQuery` also refuses `invalid_response`: the same request gets the same unparseable answer.
  - The mutation toast skips a 401 only while `setUnauthorizedHandler` has a handler registered (`hasUnauthorizedHandler()`); before phase 3 registers it, a 401 toasts its message instead of failing silently. It also skips an `AbortError` (a cancellation, not a failure).
  - A per-call `mutate(v, { onError })` is invisible to `MutationCache` (it lives on the observer), so it cannot suppress the toast. `src/lib/query/mutationOnErrorGuard.test.mjs` fails on any such call; put `onError` on `useMutation` or set `meta: { errorToast: false }`.
  - `stableStringify` applies `toJSON` (a `Date`) before sorting keys; it used to turn a `Date` into `{}`.
  - `spendRefusedView` returns `text` (message + recovery), used by both the card and the toast. The `inline` variant shows no title, so `SpendRefusedError` puts the title first in the message there.

### Phase 2 — Interaction helpers

**Goal:** polling, optimistic, URL state, preferences, search tabs, recent searches and prefetch helpers exist with unit tests.

- [x] **P2.T1 Polling**
  - [x] **P2.T1.S1** *Files:* `src/lib/query/polling.ts`, `polling.test.ts`. *Do:* `pollIntervalMs` cases: inactive → false; active with `pollAfterSeconds` 2 and floor 4 → 4000; 10 → 10000; null → fallback × 1000; scan config floor 2.5/fallback 2.5 → 2500; `pacedStaleTime` 0/Infinity/undefined-data 0; `finishTransition` running→completed true, completed→completed false, undefined→completed false (already finished on open), different run ids false. *Verify:* `node --test src/lib/query/polling.test.ts` → pass (F05-AC-05, F05-AC-13 unit).
  - [x] **P2.T1.S2** *Files:* `src/components/app/hooks/useServerPacedQuery.ts`, `src/components/app/hooks/useJobStatus.ts`. *Do:* §6.2. *Verify:* `npm run typecheck` → exit 0.
- [x] **P2.T2 Optimistic**
  - [x] **P2.T2.S1** *Files:* `src/lib/query/optimistic.ts`, `optimistic.test.ts`, `src/components/app/hooks/useOptimisticMutation.ts`. *Do:* tests with a real `QueryClient` from `@tanstack/query-core`: seed two queries under `["rows","a",1]` and `["rows","a",2]`, run `onMutate` → both patched; `onSettled(undefined, new Error())` → both invalidated (`isInvalidated` true); `onSettled(data, null)` → not invalidated; a mutation built with these handlers and no `onError` still triggers the client's toast (use `createQueryClient` with a recording toast). *Verify:* `node --test src/lib/query/optimistic.test.ts` → pass (F05-AC-06).
- [x] **P2.T3 URL state and filters**
  - [x] **P2.T3.S1** *Files:* `src/lib/query/filterSearchParams.ts`, `filterSearchParams.test.ts`. *Do:* COPY; tests: `{minVol:"10."}` → `{minVol:10}`; `{include:" a "}` → `{include:"a"}`; `""` → `undefined`; round trip `normalizeFilterValues`. *Verify:* `node --test src/lib/query/filterSearchParams.test.ts` → pass.
  - [x] **P2.T3.S2** *Files:* `src/lib/query/urlState.ts`, `urlState.test.ts`. *Do:* tests: missing params → defaults; `?page=3` with default `page: 1` → `3` (number); `?view=bogus&q=x` → `view` default, `q` "x"; repeated `?tags=a&tags=b` with `arrays: ["tags"]` → `["a","b"]`; `buildSearch` drops defaults, `""`, `[]`, keeps unknown keys, sorts. *Verify:* `node --test src/lib/query/urlState.test.ts` → pass (F05-AC-07 unit).
  - [x] **P2.T3.S3** *Files:* `src/components/app/hooks/{useUrlSearchState,useDebouncedDraft,useDebouncedFilters}.ts`. *Do:* §6.2. *Verify:* `npm run typecheck` → exit 0.
- [x] **P2.T4 Preferences, tabs, history**
  - [x] **P2.T4.S1** *Files:* `src/lib/query/localPrefs.ts`, `localPrefs.test.ts`, `src/components/app/hooks/useLocalPref.ts`. *Do:* tests with a `Map`-backed fake `Storage` and a throwing one: key format; valid JSON passes the schema; invalid JSON or schema failure → fallback; write returns false when storage throws. *Verify:* `node --test src/lib/query/localPrefs.test.ts` → pass (F05-AC-08).
  - [x] **P2.T4.S2** *Files:* `src/lib/query/searchTabsState.ts`, `searchTabsState.test.ts`, `src/components/app/search-tabs/{useSearchTabs.ts,useSearchTabNavigation.ts,SearchTabStrip.tsx}`. *Do:* PORT of OpenSEO's tests `useSearchTabs.test.ts:29-211` with a test-only `parseInput` (zod object `{ type: "q", text: string.min(1) }`): eviction keeps tab-1…tab-20; stored 25 keep tab-5…tab-24; malformed dropped; `activeTabId` kept only when present; plus `closeTabState` right-then-left neighbour; `openTabState` with an identical input re-activates without adding. *Verify:* `node --test src/lib/query/searchTabsState.test.ts` → pass (F05-AC-09).
  - [x] **P2.T4.S3** *Files:* `src/lib/query/localHistory.ts`, `localHistory.test.ts`, `src/shared/json.ts`, `src/components/app/hooks/{useLocalHistoryStore,useTimestampedSearchHistory}.ts`, `src/components/app/RecentSearches.tsx`. *Do:* tests: add puts newest first and removes the duplicate; 21st item drops the oldest; remove by key; invalid stored JSON → `[]`; `saveHistory` with a throwing storage does not throw. *Verify:* `node --test src/lib/query/localHistory.test.ts` → pass (F05-AC-10).
- [x] **P2.T5 Prefetch**
  - [x] **P2.T5.S1** *Files:* `src/components/app/PrefetchLink.tsx`, `src/components/app/navigation/navModel.ts` (add optional `prefetch`). *Do:* §6.2. *Verify:* `npm run typecheck` → exit 0; `node --test src/components/app/navigation/navModel.test.ts` → pass.

**Checkpoint:** suite, typecheck, build. Completes F05-AC-05 … -10 (unit).

### Phase 3 — Portal migration (requires `fix/run-scan-unapproved-panel` merged)

**Goal:** the portal context, scan tracker, Overview panel read and scan report run on queries with unchanged behaviour; prefetch and URL-held filters work.

- [x] **P3.T1 Test support**
  - [x] **P3.T1.S1** *Files:* `src/lib/fakeReactQuery.mjs` (new). *Do:* `export function createFakeReactQuery(react)` returning `{ __esModule: true, useQuery, useQueryClient, useMutation, keepPreviousData }` built only on `react.useState/useEffect/useRef/useCallback` (the hooks the lifecycle React provides): `useQuery(o)` keeps `{ status, data: o.initialData, error, dataUpdatedAt, errorUpdatedAt, fetchStatus }`; when `o.enabled !== false` and `JSON.stringify(o.queryKey)` or a refetch counter changes, runs `o.queryFn({ queryKey: o.queryKey, signal: new AbortController().signal })` once and stores data (`dataUpdatedAt = ++clock`) or error (`errorUpdatedAt = ++clock`); applies `o.select` to data; never polls (cadence is covered by `polling.test.ts`); returns `isPending`, `isError`, `isSuccess`, `isFetching`, `refetch`. `useQueryClient()` returns a recorder `{ calls: [], invalidateQueries, prefetchQuery, cancelQueries, setQueryData, setQueriesData, getQueryData }`. `useMutation` runs `mutationFn` and the callbacks. *Verify:* used by P3.T3.S3.
- [x] **P3.T2 Portal context**
  - [x] **P3.T2.S1** *Files:* `src/lib/query/portalQueries.ts`, `portalQueries.test.ts`. *Do:* §6.2; tests: keys and URLs per builder (mock `globalThis.fetch`, call `queryFn({ signal })`); no builder sets `placeholderData`; `enabled` false for `""`; `panelQueryOptions(...).staleTime === 0`. *Verify:* `node --test src/lib/query/portalQueries.test.ts` → pass (F05-AC-11 unit).
  - [x] **P3.T2.S2** *Files:* `src/components/portal/PortalShell.jsx`, `src/components/app/shell/AppSidebar.tsx` (prefetch on items), `src/components/app/navigation/items.ts` (`prefetch` for Overview, Questions, Search Console). *Do:* §6.3 PortalShell. *Verify:* `npm run build` → exit 0; `node --test src/components/portal/` → pass.
- [x] **P3.T3 Scan tracker**
  - [x] **P3.T3.S1** *Files:* `src/components/portal/scanTrackerModel.js`, `src/components/portal/scanTrackerModel.test.mjs`. *Do:* §6.3; tests (pure, no React): adoption of the first active unsettled job; 404 settles and never re-adopts the same id on a later `jobsSeen` with a fresh array; `complete`/`failed` settle, set `finished`, bump `notifySeq`; `transient_error` and `status:"unknown"` keep the job and mark progress unknown; `statusReceived` for another job id is ignored; `brandChanged` resets `settledJobIds`; `startResolved` with a stale `brandKey` is ignored; `alreadyRunning` sets the notice and bumps `notifySeq`; `panelNotApproved` sets `errorCode` and today's sentence; `trackerView` matches today's fields for a running job (`percent` 37, `stageIndex` 2). *Verify:* `node --test src/components/portal/scanTrackerModel.test.mjs` → pass (F05-AC-12 unit).
  - [x] **P3.T3.S2** *Files:* `src/components/portal/useScanTracker.js`. *Do:* §6.3 hook. *Verify:* `git grep -n '/api/scan/\${encodeURIComponent(jobId)}/status' -- src/components/portal/useScanTracker.js` → one match.
  - [x] **P3.T3.S3** *Files:* `src/components/portal/portalRegressions.test.mjs`, `src/components/portal/portalProgress.test.mjs`. *Do (reason: `useScanTracker.js` now imports `@tanstack/react-query`, `@/lib/query/polling`, `@/lib/query/keys` and `./scanTrackerModel`, which the harness must be told about; assertions are unchanged):* in `trackerLifecycle` add to the modules map `["@tanstack/react-query", createFakeReactQuery(lifecycle.react)]`, `["@/lib/query/polling", await import("../../lib/query/polling.ts")]`, `["@/lib/query/keys", await import("../../lib/query/keys.ts")]`, `["./scanTrackerModel", await import("./scanTrackerModel.js")]`; in `portalProgress.test.mjs` `loadTracker()` add the same four with `createFakeReactQuery(React)`. *Verify:* `node --test src/components/portal/portalRegressions.test.mjs src/components/portal/portalProgress.test.mjs` → pass (F05-AC-12).
- [x] **P3.T4 Overview and report**
  - [x] **P3.T4.S1** *Files:* `src/app/portal/page.jsx`. *Do:* §6.3 Overview panel. *Verify:* build → exit 0.
  - [x] **P3.T4.S2** *Files:* `src/app/portal/scans/[scanId]/page.jsx`, `src/components/portal/scans/ReportCards.jsx`, `src/app/portal/scans/page.jsx`, `src/components/portal/overview/RecentScans.jsx`. *Do:* §6.3 Scan report and scan-row prefetch. *Verify:* build → exit 0.
  - [x] **P3.T4.S3** *Files:* `src/components/portal/portalRegressions.test.mjs`, `src/components/portal/tenantWorkspace.test.mjs`. *Do (reason: the report page and scans page import query helpers; assertions unchanged):* in "the report renders its By engine card…" and `renderCustomerReport` add `["@tanstack/react-query", createFakeReactQuery(lifecycle.react)]`, `["@/lib/query/portalQueries", await import("../../lib/query/portalQueries.ts")]`, `["@/lib/query/fetchJson", await import("../../lib/query/fetchJson.ts")]`, `["@/components/app/hooks/useUrlSearchState", { useUrlSearchState: (_s, defaults) => [defaults, noop] }]`, `["@/components/app/hooks/useDebouncedDraft", { useDebouncedDraft: (value) => [value, noop] }]`, `["zod", await import("zod")]`; in `tenantWorkspace.test.mjs` "tenant Scans renders a runnable mock…" add `autoStub: ["@/components/app/PrefetchLink"]` and `["@/lib/query/portalQueries", await import("../../lib/query/portalQueries.ts")]`. The response doubles already provide `status`, `ok`, `json()`. *Verify:* `node --test src/components/portal/` → pass.
- [x] **P3.T5 Browser checks**
  - [x] **P3.T5.S1** *Files:* `scripts/qa/check-f05-browser.mjs` (new), `tests/fixtures/portal/{overview-acme-running.json,scan-status-sequence.json}` (new), `.github/workflows/ci.yml` (run it after `check-f04-browser.mjs`). *Do:* using `openPortal` from `scripts/qa/portalFixtureHarness.mjs`:
    - `F05-B01` delay the `acme` overview response 1.5 s, switch to Beta at once, wait 3 s: the page never shows Acme's KPI values (poll the DOM every 100 ms) and ends on Beta's.
    - `F05-B02` overview with a running job; the status route answers `probing` 15/40/70 then `complete`; over the first 6 s the status endpoint is called 3 ± 1 times; after `complete`, no status call in the next 5 s and exactly one overview refetch.
    - `F05-B03` hover "Questions" → one `GET /api/customer/repairs/panel` before clicking; hover the row of `scan-1` on `/portal/scans` → one `GET /api/customer/scan/report/scan-1`; click → report visible and no second report request.
    - `F05-B04` make `/api/customer/overview` return 401 → URL becomes `/login?next=%2Fportal` and only one navigation to `/login` is recorded.
    - `F05-B05` on `/portal/scans/scan-1` type "pricing" in "Search questions" (`page.keyboard.type`, 50 ms per key) → the URL has no `q` while typing and `?q=pricing` within 600 ms after the last key; reload keeps the filtered list; selecting the engine "ChatGPT" adds `engine=chatgpt` immediately; "Clear filters" removes all three params.
    - `F05-B06` overview fixture answers 402 `{ error: "Today's spend limit for this workspace has been reached.", code: "daily_cap", recovery: "Try again tomorrow or ask the workspace owner to raise the limit." }` on `/portal` and features `{ usage_page: false }` → the Overview error card shows "Daily spend limit reached", the message and recovery, and no "Try again" or "View usage" button.
    - `blockedWrites` stays 0.
    *Verify:* local `next start -p 3328` (CI placeholder env) → all cases pass (F05-AC-03, -07, -11, -13, -14, -15).

**Checkpoint:** suite, typecheck, build, `check-f04-browser.mjs`, `check-f05-browser.mjs`, `check-public-browser.mjs` → pass; `features/README.md` F05 → Merged. Completes F05-AC-03, -11 … -15.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/query/queryClient.test.ts` | defaults, toast rules, 401 silent, spend toast, retry rules | 01 |
| `src/lib/query/fetchJson.test.ts` | success, empty, schema, error envelope, legacy `detail`, 401 handler, network, abort, headers, `withBrand` | 02 |
| `src/lib/query/errors.test.ts` | spend detection, card copy, `describeError` | 03 |
| `src/lib/query/keys.test.ts` | shapes, workspace predicate, `stableStringify` | 04 |
| `src/lib/query/polling.test.ts` | interval, stale time, finish transition, scan cadence | 05, 13 |
| `src/lib/query/optimistic.test.ts` | patch, invalidate on error, toast kept | 06 |
| `src/lib/query/filterSearchParams.test.ts`, `urlState.test.ts` | parse, coerce, fallback per key, strip defaults | 07 |
| `src/lib/query/localPrefs.test.ts` | keys, schema, throwing storage | 08 |
| `src/lib/query/searchTabsState.test.ts` | OpenSEO cases + close/open rules | 09 |
| `src/lib/query/localHistory.test.ts` | order, dedupe, cap, invalid JSON, throwing storage | 10 |
| `src/lib/query/portalQueries.test.ts` | keys, URLs, no `placeholderData`, panel stale time | 11 |
| `src/components/portal/scanTrackerModel.test.mjs` | reducer table of §6.3 | 12 |
| `portalRegressions.test.mjs`, `portalProgress.test.mjs`, `tenantWorkspace.test.mjs` (maps updated) | existing assertions | 12 |
| `scripts/qa/check-f05-browser.mjs` | B01–B06 | 03, 07, 11, 13, 14, 15 |

Fixtures: invented JSON under `tests/fixtures/portal/`; no provider calls; the harness aborts customer writes.

## 10. Rollout and rollback

- No env vars, flags or migrations.
- Phases 1–2 change no behaviour. Phase 3 changes how the portal loads data; it deploys after `check-f05-browser.mjs` passes.
- Rollback: revert phase 3 (the old fetch code returns); phases 1–2 can stay.
- F09 phase 3 lands after F05 phase 3 and edits `useScanTracker.js` as F09 §6.6.2 describes, on top of `postStart`.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | The scan status route sends no `pollAfterSeconds`. | Keep today's 2.5 s cadence through floor/fallback; do not touch the P0 route. A later spec may add `poll_after_seconds` with its own tests. |
| 2 | The fake React Query in lifecycle tests could diverge from real behaviour. | It only runs `queryFn` on key/enable changes; polling and stale-time rules are unit-tested on the pure helpers and end-to-end in `check-f05-browser.mjs`. |
| 3 | `refetchOnWindowFocus` (default true) adds overview requests when users switch tabs. | Accepted (OpenSEO default); the overview is cheap and `staleTime` 5 minutes limits it. |
| 4 | F09's text cites line numbers in today's lifecycle tests (`:112-175`). | After F05 the same tests exist with the same names; F09's subtask applies to them by name. |
| 5 | Other portal pages keep hand-written fetches. | Allowed until each is next changed; new code must use F05 (stated in §5). |
| 6 | `next/navigation` `router.replace` adds history entries differently from TanStack's `replace: true`. | `useUrlSearchState` uses `router.replace` for filters (no history entry), `router.push` only when a caller passes `{ replace: false }`. |

## 12. Definition of done

- [x] Phases 1–3 merged; subtasks ticked.
- [x] F05-AC-01 … F05-AC-15 covered by passing tests or recorded browser runs.
- [x] `npm test`, `npm run typecheck`, `npm run build` green; `check-f05-browser.mjs` in CI.
- [x] `THIRD_PARTY_NOTICES.md` updated; `features/README.md` status updated.

## Deviations from conventions

1. **`src/lib/fakeReactQuery.mjs`** is a test helper in `src/` next to `src/lib/renderHarness.mjs` (same precedent), not a fixture under `tests/fixtures/`.
2. **`useScanTracker.js` stays JavaScript and keeps raw `fetch`** for the status route and the start POST, because the existing lifecycle tests and the P0 status semantics depend on it; all other new client code uses `fetchJson`.
3. **Query-key rule** (`[domain, brandKey, …]`, id-addressed `[domain, id]`) and the `WorkspaceContext` are new shared conventions; conventions §5 should list `src/lib/query/keys.ts`, `fetchJson`, `ApiError` and `useWorkspace()` (requested in the final report).
