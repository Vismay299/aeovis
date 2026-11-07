# F06 — Data tables and export

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F06 |
| Wave | 0 |
| Comparison rows covered | "Tables and export" (shared table with range select, bulk actions, export to Sheets, CSV with formula protection, Excel, JSON); backend pattern "Formula-safe CSV export with short-lived links" |
| Depends on | F04 phases 2–4 (primitives, `EmptyState`, `reveal-on-hover`, `AppProviders`, `CLIENT_FEATURES`); F05 phases 1–3 (`QueryClient`, `fetchJson`, `useUrlSearchState`, `PrefetchLink`, `WorkspaceContext`, scan report on queries); F01 phases 1–3 (`requireWorkspace`, `toErrorResponse`, contracts, `isFeatureEnabled`, `definePeriodic`/jobs) for phase 3 only |
| Blocks | F13, F14, F15, F16, F18, F23 tables; F12 history export |
| Reserved migrations | 065–069. **065 used** (`065_f06_exports.sql`: private bucket `exports` and table `export_requests`). 066–069 unused. |
| Feature flag | `FEATURE_SERVER_EXPORTS` (`server_exports`; server-side export route and its menu scope). Client-side table export has no flag. |
| Spend features | none (no paid provider calls; Storage only) |
| OpenSEO reference | `openseo:src/client/components/table/*`, `openseo:src/client/components/ExportMenu.tsx`, `openseo:src/client/lib/{csv,clipboard,download,exportRows,exportToSheets}.ts`, `openseo:src/server/features/ai-visibility/services/aiVisibilityExport.ts` at `c5f8db1` |

## 1. Summary

Every list of rows in the customer app becomes one shared table: sortable headers, skeleton rows under the real headers while loading, a filtered-empty state with "Clear filters", shift-click range selection with a floating bulk-action bar, and hover-revealed row actions. Every table gets the same Export menu: copy to Google Sheets, CSV with spreadsheet-formula protection, Excel and JSON. Large exports (all answers of a workspace over a date range) are built on the server, stored privately and handed back as a one-hour signed link. The scan report's JSON-only download becomes this menu, and the Scans history becomes the first shared table.

## 2. What OpenSEO does (observed)

1. `useDataTable` wraps `useReactTable` and adds sorted, expanded and paginated row models only when asked (`openseo:src/client/components/table/DataTable.tsx:50-71`). Column `meta` carries `headerClassName` and `cellClassName` (string or per-row function) (`DataTable.tsx:39-48`).
2. Selection column: header checkbox (all / indeterminate / disabled when nothing is selectable) and row checkboxes with an accessible label; a shift-click on a row checkbox selects the range instead of toggling and suppresses text selection (`DataTable.tsx:77-139`). Range logic: a plain click sets the anchor `{ id, selected: !wasSelected }`; a shift-click applies the anchor's state to every selectable row between anchor and target and moves the anchor (`openseo:src/client/components/table/tableSelection.ts:17-71`); tested for select, clear and skipping locked rows (`openseo:src/client/features/rank-tracking/tableSelection.test.ts:50-119`).
3. Table frame (`DataTable.tsx:141-318`): the toolbar sits inside the card; an error shows above the rows, and with no rows replaces the table "so a failed load never reads as empty" (`:149-152`, `:203-204`); the header is sticky when the body scroll is capped (`:206-210`); the first load shows **8 skeleton rows under the real headers** (a `size-4` skeleton in the select column) (`:230-243`); no rows + filters → `EmptyState kind="filtered"` "No rows match these filters" / "Change or clear the filters to see more rows." with "Clear filters" (`:244-264`); otherwise the caller's empty state (`:265-266`); clickable rows get a primary inset bar when active (`:273-284`); expanded rows render full-width (`:302-308`).
4. Toolbar parts: `DataTableTabs`, `DataTableToolbar` (filters left, actions right), `DataTableFilterToggle` with an active-count badge, `DataTableFilterPanel` ("Refine results", "{n} active", "Clear all"), `DataTableFilterGroup`, `DataTableRangeFilter` (Min/Max) (`openseo:src/client/components/table/DataTableToolbar.tsx:15-175`).
5. Bulk bar: fixed at `bottom-6`, centred, `role="toolbar" aria-label="Bulk actions"`, a clear button "Clear selection", the count and a label, then action buttons; a danger variant; an Export dropdown opening upwards (`openseo:src/client/components/table/TableBulkActionBar.tsx:11-115`). Rendered only when something is selected (`:22`).
6. Pagination: "1–50 of 1,234", optional "Rows per page", "Page x of y", previous/next, optional load-more, and a jump back when the page falls past the end (`openseo:src/client/components/table/TablePagination.tsx:43-182`).
7. `SortableHeader` is a button with `aria-pressed` and up/down arrows, optionally a help tooltip (`SortableHeader.tsx:9-49`). `numericNullsLast` keeps blanks at the bottom in both directions because TanStack's `sortUndefined: "last"` flips on descending (`nullSafeSort.ts:1-42`).
8. URL cells: display form drops scroll-to-text fragments and decodes; hrefs go through `safeHttpUrl`; relative paths resolve against a base domain (`openseo:src/client/components/table/url.tsx:4-58`, test `url.test.ts:4-17`). Difficulty tiers as badges (`ScoreBadge.tsx:1-20`). Row actions use the `reveal-on-hover` utility (`openseo:src/client/styles/app.css:190-194`) and `RowActionsMenu`.
9. Export menu: actions `sheets` "Export to Sheets", `csv` "Export CSV", `excel` "Export Excel", `json` "Download JSON", `copy-json` "Copy JSON", `copy-list` "Copy list" with icons; optional labelled scopes; a busy spinner on the trigger (`openseo:src/client/components/ExportMenu.tsx:24-101`).
10. `exportRows()` is the single entry point: zero rows → toast "No data to export" and nothing else; `sheets` → clipboard + modal; `copy-json` → clipboard + "Copied data"; `json` → download; `csv`/`excel` → download, "Excel is the same CSV with an .xls extension"; then the analytics event `data:export { source_feature, format, result_count, scope }` (`openseo:src/client/lib/exportRows.ts:7-73`; tests `exportRows.test.ts:22-60`).
11. CSV: `papaparse.unparse` with `quotes: true`, `newline: "\n"`; numbers rounded to 2 decimals; cells starting with `= + - @ \t \r \n` are prefixed with `'` (OWASP CSV injection) (`openseo:src/client/lib/csv.ts:7-50`; tests `csv.test.ts:4-26`).
12. Sheets: writes TSV and an HTML table to the clipboard (Safari `Promise<Blob>` wrapper), flattens tabs/newlines in cells, renders safe URLs as links, escapes HTML (`openseo:src/client/lib/clipboard.ts:6-71`; tests `clipboard.test.ts:41-78`); then a modal "Copied {n} row(s) to your clipboard" / "Open a new Google Sheet and paste to fill it." / "Open new Google Sheet" → `https://sheets.new` in a new tab; it never auto-opens because users would not realise the data is on the clipboard; it closes on navigation; event `data:export_sheets` (`openseo:src/client/lib/exportToSheets.ts:11-69`, `openseo:src/client/components/table/ExportToSheetsModal.tsx:19-66`).
13. Downloads use a Blob, an object URL and a temporary anchor (`openseo:src/client/lib/download.ts:1-9`).
14. Server export (`openseo:src/server/features/ai-visibility/services/aiVisibilityExport.ts`): refuses history scope (`:17-21`) and "no run" (`:23-27`); builds JSON `{ exportedAt, projectId, run, coverage, answers }` or CSV with columns `run_id, observation_id, prompt, engine, status, collected_at, brand_mentions, citation_urls, answer`, cells quoted and formula-guarded with `^[\s]*[=+@-]`, lines `\r\n` (`:9-13`, `:28-73`); stores the body at `ai-visibility/<project>/exports/<uuid>` with `expiresAt = now + 1 h` (`:74-81`); returns an absolute download URL (`:82-89`). The download handler re-authenticates, checks the project belongs to the organisation, returns 410 after expiry, and serves with `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` (`:92-135`). Tests: absolute link; one row per answer with its own mentions and citations (`aiVisibilityResults.test.ts:267-311`).
15. **(inferred)** No virtualization and no column visibility or density controls: `DataTable` renders every row of the row model (`DataTable.tsx:271-310`) and no table file references a virtualizer or column-visibility state.

## 3. What Perceev has today

- No table library. Lists are hand-written markup: the Scans "Scan history" table (`src/app/portal/scans/page.jsx:163-188`, rows from `GET /api/customer/scan?brand_key=` — latest 20 scans with `visibility_pct`, `prompts_tracked`, `prompts_mentioned`, `platform`, `collection_partial`, `src/app/api/customer/scan/route.js:82-112`), Team and Search Console tables (deferred Mixed rows; restyled by F04 only).
- Export: one button "Download measurement JSON" on the scan report that downloads the exact report DTO as `measurement-<scanId>.json` (`src/app/portal/scans/[scanId]/page.jsx:72-75`, `:111-113`). Test "R05 customer report download is the exact report DTO the page rendered" (`src/components/portal/portalRegressions.test.mjs:434-450`) finds the `ui.Button` inside `data-testid="customer-collection-outcome"`, calls its `onClick`, and checks the filename and the blob content.
- No CSV, no clipboard export, no server-side export, no `exports` Storage bucket. The private-bucket and signed-URL patterns exist: `supabase/migrations/019_probe_evidence_bucket.sql`, `src/lib/evidenceSignedUrl.js`, `src/app/api/customer/measurement/evidence/route.js:43`.
- `prompt_results` (`supabase/migrations/005_analytics_platform.sql:8-29`) holds `scan_id`, `query`, `engine`, `answer_text`, `answered`, `mentioned`, `brand_cited`, `position`, `sentiment`, `raw` (with `raw.references[]` items `{ href, title, source }` and `raw.brands[]` items `{ name, is_self, mentioned }`); `scans` has `brand_key`, `scanned_at`.
- Migration ledgers enforced by tests: `scripts/setup-supabase.mjs` required objects (`src/lib/migrationsLedger.test.mjs`), the README migration table, `docs/OPERATOR_LEDGER.md` § C and `docs/PROD_MIGRATIONS.md` (`src/lib/docStatus.test.mjs:158-240`); tenant RLS SQL in `tests/customer-uat.sql` run by CI's `customer-database` job.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F06-AC-01 | While the first page loads, a table shows its real headers and exactly 8 skeleton rows; no rows with active filters shows "No rows match these filters" with "Clear filters"; a load error with no rows replaces the table, with rows it sits above them. | browser `scripts/qa/check-f06-browser.mjs` `F06-B01` |
| F06-AC-02 | Shift-click selection: a plain click sets the anchor; a shift-click applies the anchor's selected state to every selectable row between anchor and target (selecting or clearing) and skips locked rows. | unit `src/lib/table/tableSelection.test.ts`; browser `F06-B02` |
| F06-AC-03 | The bulk bar appears only with ≥ 1 selected row, shows the count, "Clear selection" empties the selection, and "Export" in the bar exports only the selected rows. | browser `F06-B02` |
| F06-AC-04 | `numericNullsLast` keeps blank values last in both sort directions. | unit `src/lib/table/nullSafeSort.test.ts` |
| F06-AC-05 | URL helpers: scroll-to-text fragments dropped, normal hashes kept, unsafe schemes rejected, relative paths resolved against the base domain. | unit `src/lib/table/url.test.ts` |
| F06-AC-06 | CSV rounds numbers to 2 decimals, quotes every cell, prefixes `'` to cells starting with `= + - @ \t \r \n`; the Excel variant is the same CSV with a UTF-8 BOM and an `.xls` name. | unit `src/lib/export/csv.test.ts` |
| F06-AC-07 | Clipboard export writes TSV (cells flattened) and an escaped HTML table with safe URLs as links. | unit `src/lib/export/clipboard.test.ts` |
| F06-AC-08 | `exportRows` refuses zero rows for every format with "No data to export" and no download, clipboard write or event; otherwise downloads/copies and records `data:export`. | unit `src/lib/export/exportRows.test.ts` |
| F06-AC-09 | "Export to Sheets" copies the rows and opens the modal "Copied {n} rows to your clipboard"; its button opens `https://sheets.new` in a new tab; navigating away closes it. | browser `F06-B03` |
| F06-AC-10 | Scan report Export menu: "Download JSON" (scope "This report") downloads the exact report DTO as `measurement-<scanId>.json`; the "Questions" scope exports one row per question × engine, including planned engines that were not collected ("Not collected"), with blanks — never `0` or "No" — where a value is unknown, filtered exactly like the visible list. | unit `src/components/portal/scans/reportExport.test.mjs`; existing `portalRegressions` test (updated); browser `F06-B04` |
| F06-AC-11 | Scans history is a `DataTable`: sortable by date (default newest first) and AI visibility (blanks last), sort held in the URL, a row opens its report, the date links prefetch it, and the Export menu exports the history with blank visibility for unmeasured scans. | browser `F06-B04`, `F06-B05` |
| F06-AC-12 | `POST /api/customer/exports`: flag off → 403 `feature_disabled`; unknown fields → 400; bad range → 400 `invalid_range`; 21st request in an hour → 429 `export_rate_limited`; no rows → 422 `no_rows`; over 50,000 rows → 413 `export_too_large` with nothing stored; success stores `exports/<brandKey>/workspace_answers/<id>.<ext>`, records `export_requests` (`ready`, row count, bytes), and returns a signed URL valid 3,600 s with a download filename; only the caller's workspace's scans are read. | route `src/lib/export/exports.route.test.mjs` |
| F06-AC-13 | Server CSV: fixed header order, `\r\n` lines, every cell quoted, formula guard also catching leading whitespace, unknown values blank, citation URLs only http(s). | unit `src/lib/export/kinds/workspaceAnswers.test.ts` |
| F06-AC-14 | Migration 065 applies twice cleanly; bucket `exports` is private with a 25 MiB limit and CSV/JSON MIME types; a member reads only their workspace's `export_requests` rows; `anon` reads none. | DB `tests/customer-uat.sql` block; `scripts/qa/check-f06-db.mjs` |
| F06-AC-15 | Retention: objects of requests older than 2 hours are removed through the Storage API and the rows marked `deleted`; rows older than 90 days are pruned. | unit `src/lib/export/retention.test.ts` |
| F06-AC-16 | (Optional phase 4) Virtualized tables render only the rows in the scroll window plus overscan, with spacer rows keeping the scroll height. | unit `src/lib/table/virtualWindow.test.ts` |

## 5. Scope

**In scope**
- The table kit (`DataTable`, toolbar parts, bulk bar, pagination, sortable header, null-safe sort, selection, URL cell, score badge, `MetricsTable`).
- The export kit (`ExportMenu`, `exportRows`, CSV, clipboard/Sheets with modal, downloads) and a React hook binding it to toasts and telemetry.
- Server export framework (route, kind registry, Storage, audit table, rate limit, retention) with one kind, `workspace_answers`.
- Scan report: Export menu replacing the JSON button. Scans history: `DataTable` with selection, URL-held sort and export.
- Optional phase 4: row virtualization.

**Out of scope**
- Column visibility and density controls (OpenSEO has none; parity kept).
- Team and Search Console tables (deferred Mixed rows; F04 restyles them, no export added).
- Exports for features not built yet (each later spec adds its table and, if needed, a server export kind).
- Scheduled or emailed exports (comparison row "Neither").
- Changing the scan report API or the JSON DTO.

## 6. Design

### 6.1 Data model — `supabase/migrations/065_f06_exports.sql`

```sql
-- 065: F06 server-side exports. Private Storage bucket `exports` and an audit /
-- rate-limit table. Safe to re-run.
--
-- PRIVATE: objects are written and read only with the service role; customers get
-- one-hour signed URLs (features/F06 §6.5). No storage.objects policies are created.
-- RETENTION: objects are deleted through the Storage API by the `exports.retention`
-- periodic (src/lib/export/retention.ts), never by SQL (protect_objects_delete).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'exports',
  'exports',
  false,
  26214400,                                            -- 25 MiB per object
  ARRAY['text/csv', 'application/json']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.export_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key    text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  kind         text NOT NULL,
  format       text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',
  row_count    integer,
  byte_size    integer,
  storage_path text,
  error_code   text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  deleted_at   timestamptz,
  CONSTRAINT export_requests_kind_ck   CHECK (kind ~ '^[a-z][a-z0-9_]{2,40}$'),
  CONSTRAINT export_requests_format_ck CHECK (format IN ('csv', 'json')),
  CONSTRAINT export_requests_status_ck CHECK (status IN ('pending', 'ready', 'failed', 'deleted')),
  CONSTRAINT export_requests_counts_ck CHECK ((row_count IS NULL OR row_count >= 0) AND (byte_size IS NULL OR byte_size >= 0)),
  CONSTRAINT export_requests_path_ck   CHECK (storage_path IS NULL OR storage_path LIKE brand_key || '/%')
);
COMMENT ON TABLE  public.export_requests IS 'F06: one row per server-side export; audit trail, hourly rate limit and retention list.';
COMMENT ON COLUMN public.export_requests.params IS 'Kind parameters as validated by the route (for workspace_answers: {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}). Never contains answer text.';
COMMENT ON COLUMN public.export_requests.created_by IS 'auth.users id of the requester; no foreign key so account deletion never blocks.';
COMMENT ON COLUMN public.export_requests.expires_at IS 'When the signed URL handed out stops working (created_at + 1 hour).';

CREATE INDEX IF NOT EXISTS export_requests_brand_created_idx ON public.export_requests (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS export_requests_cleanup_idx ON public.export_requests (created_at)
  WHERE deleted_at IS NULL AND storage_path IS NOT NULL;

ALTER TABLE public.export_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_requests_read ON public.export_requests;
CREATE POLICY export_requests_read ON public.export_requests
  FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
REVOKE ALL ON public.export_requests FROM PUBLIC, anon;
GRANT SELECT ON public.export_requests TO authenticated;
GRANT ALL ON public.export_requests TO service_role;

NOTIFY pgrst, 'reload schema';
```

### 6.2 Modules

Pure modules (relative imports with `.ts` extensions, node-testable): `src/lib/table/`, `src/lib/export/`. React: `src/components/app/table/`, `src/components/app/ExportMenu.tsx`, `src/components/app/export/`.

#### `src/lib/table/`

| File | Exports |
|---|---|
| `tableSelection.ts` | COPY: `SelectionAnchor`, `applyShiftRangeSelection(event, row, table, anchorRef): boolean` (type-only TanStack imports). |
| `nullSafeSort.ts` | COPY: `numericNullsLast(rowA, rowB, columnId)`, plus `compareNumericNullsLast(a, b, descending)` exported for tests. |
| `url.ts` | COPY of the pure half of `url.tsx`: `formatUrlForDisplay`, `resolveUrlHref` (uses `../../shared/safe-url.ts`). |
| `virtualWindow.ts` | Phase 4: `virtualWindow({ scrollTop, viewportHeight, rowHeight, rowCount, overscan }): { start: number; end: number; padTop: number; padBottom: number }`. |

#### `src/lib/export/` (client side)

| File | Exports |
|---|---|
| `csv.ts` | COPY: `CsvValue`, `ExportValue`, `buildCsv(headers, rows)`, `normalizeExportValue(value)`; addition `buildExcelCsv(headers, rows) = "﻿" + buildCsv(headers, rows)`. |
| `clipboard.ts` | COPY: `GOOGLE_SHEETS_NEW_URL = "https://sheets.new"`, `copyTableToClipboard(headers, rows, deps?: { clipboard?: Clipboard; ClipboardItem?: typeof ClipboardItem })`; `buildTsv`, `buildHtmlTable` exported for tests. Missing API → `Error("Clipboard API not available in this browser.")`. |
| `download.ts` | COPY: `downloadFile(content, filename, mime)`; the object URL is revoked after `setTimeout(…, 1000)` (as the scan report does today, `page.jsx:74`). |
| `sheetsModalStore.ts` | PORT of `exportToSheets.ts:11-42`: `getSheetsModalState()`, `subscribeSheetsModal(fn)`, `openSheetsModal(rowCount)`, `closeSheetsModal()`. |
| `exportRows.ts` | PORT: `type ExportFormat = "csv" \| "excel" \| "json" \| "copy-json" \| "sheets"`; `exportRows(args: { format; feature: string; headers: string[]; rows: CsvValue[][]; filename: string; records?: unknown[]; scope?: "selection" }, deps: ExportDeps): Promise<void>`; `type ExportDeps = { toastError(m: string): void; toastSuccess(m: string): void; download(content: string, filename: string, mime: string): void; writeText(text: string): Promise<void>; copyTable(headers, rows): Promise<void>; openSheetsModal(rowCount: number): void; track(event: string, props: Record<string, unknown>): void }`. Order and copy as `exportRows.ts:26-72`; `excel` uses `buildExcelCsv` and `.xls`; sheets path tracks `data:export_sheets { source_feature, result_count }`, other paths `data:export { source_feature, format, result_count, scope }`. |
| `filenames.ts` | `exportFilename(parts: string[]): string` → lower-case, non-alphanumerics to `-`, joined by `-`, max 120 chars, prefixed `perceev-` (e.g. `perceev-acme-scan-history-2026-10-21`). |
| `telemetry.ts` | `setExportTracker(fn)`, `trackExport(event, props)` (no-op until F26 calls `setExportTracker`). |

#### `src/lib/export/` (server side)

```ts
// kinds/index.ts
export type ExportKind<P> = {
  kind: string;
  feature: string;                           // telemetry source_feature and filename part
  params: ZodType<P>;                        // strict
  maxRows: number;                           // 50_000 for workspace_answers
  load(admin: SupabaseClient, brandKey: string, params: P): Promise<{ rows: Record<string, unknown>[]; meta: Record<string, unknown> }>;
  csvHeaders: readonly string[];
  toCsvRow(row: Record<string, unknown>): (string | number | boolean | null)[];
  toJson(rows: Record<string, unknown>[], meta: Record<string, unknown>, ctx: { brandKey: string; exportedAt: string }): unknown;
  filename(brandKey: string, params: P, format: "csv" | "json"): string;
};
export const EXPORT_KINDS: Record<string, ExportKind<any>>;   // { workspace_answers }

// serverCsv.ts (PORT of aiVisibilityExport.ts:9-13, :41-73)
export function serverCsvCell(value: string | number | boolean | null | undefined): string; // null → ""; /^[\s]*[=+@-]/ or /^[\t\r\n]/ → prefix "'"; quote and double inner quotes
export function serverCsv(headers: readonly string[], rows: unknown[][]): string;           // lines joined by "\r\n"

// serverExport.ts (PORT of aiVisibilityExport.ts:16-90)
export const EXPORT_URL_TTL_SECONDS = 3600;
export const EXPORT_RATE_PER_HOUR = 20;
export const EXPORT_MAX_BYTES = 26_214_400;
export async function createServerExport(i: { admin: SupabaseClient; brandKey: string; userId: string; kind: string; format: "csv" | "json"; params: unknown; now?: () => Date }):
  Promise<{ exportId: string; url: string; expiresAt: string; format: "csv" | "json"; rowCount: number; filename: string }>;
// Throws AppError: 429 export_rate_limited, 422 no_rows, 413 export_too_large, 503 storage_unavailable.
```

`createServerExport` steps:
1. Rate: `admin.from("export_requests").select("id", { count: "exact", head: true }).eq("brand_key", brandKey).gte("created_at", now − 1 h)`; `count ≥ 20` → `AppError(429, "export_rate_limited", "This workspace has started 20 exports in the last hour. Try again later.")`.
2. Insert `export_requests` `{ id, brand_key, kind, format, params, status: "pending", created_by: userId, expires_at: now + 1 h }`.
3. `load()`; `rows.length === 0` → mark `failed`/`no_rows`, throw `AppError(422, "no_rows", "There are no answers in this date range.")`; `rows.length > maxRows` → mark `failed`/`export_too_large`, throw `AppError(413, "export_too_large", "This export has more than 50,000 rows. Choose a shorter date range.")`.
4. Body: CSV via `serverCsv(kind.csvHeaders, rows.map(kind.toCsvRow))` or `JSON.stringify(kind.toJson(...), null, 2)`; bytes > `EXPORT_MAX_BYTES` → `failed`/`export_too_large` and the same 413.
5. Upload `exports/<brandKey>/<kind>/<id>.<csv|json>` with `contentType` `text/csv; charset=utf-8` or `application/json`, `upsert: false`; failure → `failed`/`storage_unavailable`, `AppError(503, "storage_unavailable", "Export storage is unavailable. Please retry.")`.
6. `createSignedUrl(path, 3600, { download: filename })`; failure → same 503 (object left for retention).
7. Update row `ready`, `row_count`, `byte_size`, `storage_path`. Return.
8. Logs: `[exports] ready {exportId, brandKey, kind, format, rowCount, bytes}` and `[exports] failed {exportId, code}`. Never the URL, params' values or any content.

#### `kinds/workspaceAnswers.ts`

- `params = z.strictObject({ from: z.iso.date(), to: z.iso.date() })` with a refinement: `from ≤ to`, `to ≤ today (UTC)`, span ≤ 92 days → otherwise the route returns 400 `invalid_range` "Choose a date range of up to 92 days that ends today or earlier."
- `load`: `scans` where `brand_key = brandKey` and `scanned_at` in `[from 00:00Z, to + 1 day 00:00Z)`, select `id, scanned_at, visibility_pct, prompts_tracked, prompts_mentioned`, ordered by `scanned_at`, limit 500; then `prompt_results` in chunks of 100 scan ids, select `id, scan_id, query, engine, answered, mentioned, brand_cited, position, sentiment, answer_text, created_at, failed:raw->error, references:raw->references, brands:raw->brands`, ordered by `scan_id, created_at`; stop and throw 413 as soon as the running count exceeds 50,000.
- CSV headers (fixed order): `scan_id, scanned_at, answer_id, question, engine, status, names_you, cited, position, sentiment, brands_named, citation_urls, answer`.
  - `status`: `"failed"` when `failed` is truthy, `"answered"` when `answered === true`, `"no_answer"` when `answered === false`, else `"unknown"`.
  - `names_you`: `"yes"`/`"no"` only when `status === "answered"`, else blank. `cited`: `"yes"`/`"no"` from `brand_cited` when answered, else blank. `position`: number or blank. `sentiment`: stored text or blank.
  - `brands_named`: names in `brands[]` with `mentioned === true`, joined `"; "`.
  - `citation_urls`: `references[].href ?? references[].url`, kept only when `safeHttpUrl` accepts them, de-duplicated in order, joined `"; "`.
  - `answer`: `answer_text` or blank.
- JSON: `{ exportedAt, brandKey, range: { from, to }, scans: [...], answers: [same fields as CSV, typed] }`.
- `filename`: `exportFilename([brandKey, "answers", from, "to", to]) + "." + format`.

#### `retention.ts`

`definePeriodic({ name: "exports.retention", everySeconds: 3600, run })` registered from `src/lib/jobs/kinds.ts` (one import line): select up to 500 rows with `deleted_at IS NULL AND storage_path IS NOT NULL AND created_at < now − 2 h`; remove their paths from bucket `exports` in batches of 100 (`storage.from("exports").remove(paths)`); set `status = 'deleted', deleted_at = now()` for removed ones; then delete rows with `created_at < now − 90 days`. Logs counts only: `[exports.retention] removed=N pruned=M`.

#### React layer

| File | Exports |
|---|---|
| `src/components/app/table/DataTable.tsx` | COPY: `useDataTable`, `useSelectionAnchor`, `makeSelectionColumn`, `DataTableFrameProps`, `DataTable` (imports selection logic from `@/lib/table/tableSelection`). Perceev addition: optional `rowLabel` already supported; optional `virtualize` prop in phase 4. |
| `src/components/app/table/DataTableToolbar.tsx` | COPY (`DataTableTabs`, `DataTableToolbar`, `DataTableFilterToggle`, `DataTableFilterPanel`, `DataTableFilterGroup`, `DataTableRangeFilter`). |
| `src/components/app/table/TableBulkActionBar.tsx` | COPY (`TableBulkActionBar`, `TableBulkActionButton`, `TableBulkExportMenu`). |
| `src/components/app/table/TablePagination.tsx` | COPY (`TablePagination`, `PageButtonProps`). |
| `src/components/app/table/SortableHeader.tsx`, `ScoreBadge.tsx` | COPY. |
| `src/components/app/table/ExternalUrlCell.tsx` | COPY of the component half of `url.tsx` (helpers from `@/lib/table/url`). |
| `src/components/app/table/ExportToSheetsModal.tsx` | PORT: subscribes to `sheetsModalStore`; closes on `usePathname()` change; copy as `ExportToSheetsModal.tsx:47-60`. Mounted once in `AppProviders` (F04/F05 file). |
| `src/components/app/MetricsTable.tsx` | COPY (`MetricsTable`, `percentChange`). |
| `src/components/app/ExportMenu.tsx` | COPY (`ExportMenu`, `ExportAction`). |
| `src/components/app/export/useExportRows.ts` | `useExportRows()` → `(args) => exportRows(args, deps)` with `deps` bound to sonner (`toast.error`, `toast.success`), `downloadFile`, `navigator.clipboard.writeText`, `copyTableToClipboard`, `openSheetsModal`, `trackExport`. Also `copyList(items: string[], label)` for the `copy-list` action ("Copied {label}"). |
| `src/components/app/export/useServerExport.ts` | `useServerExport()` → `useMutation` posting to `/api/customer/exports` with `fetchJson`; on success `window.location.assign(url)` and `toast.success("Export ready. Your download has started.", { action: { label: "Open link", onClick: () => window.open(url, "_blank", "noopener,noreferrer") } })`; errors use the global mutation toast (F05). |

### 6.3 Jobs

No job kinds. One periodic, `exports.retention` (hourly), §6.2. It is free work and may retry.

### 6.4 Provider calls and cost

None. Storage only (≤ 25 MiB per object, deleted after 2 hours).

### 6.5 API routes

**`POST /api/customer/exports`** — `src/app/api/customer/exports/route.ts`, contract `src/lib/export/exports.contract.ts`.

- Auth: `requireWorkspace(request, { brandKey: body.brandKey })` (member or owner); then `isFeatureEnabled("server_exports", brandKey)` false → `AppError(403, "feature_disabled", "Server exports are not enabled for this workspace.")`.
- Request (strict):
  ```ts
  const exportRequest = z.discriminatedUnion("kind", [
    z.strictObject({
      brandKey: z.string().min(1).max(120),
      kind: z.literal("workspace_answers"),
      format: z.enum(["csv", "json"]),
      params: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
    }),
  ]);
  ```
  Example: `{ "brandKey": "acme", "kind": "workspace_answers", "format": "csv", "params": { "from": "2026-07-23", "to": "2026-10-21" } }`.
- Response 200 (`z.looseObject`):
  ```json
  { "exportId": "3f1c8a52-7d4e-4b8a-9a3e-2c6f0d9b1e47",
    "url": "https://example.supabase.co/storage/v1/object/sign/exports/acme/workspace_answers/3f1c8a52-7d4e-4b8a-9a3e-2c6f0d9b1e47.csv?token=EXAMPLE-NOT-A-REAL-TOKEN",
    "expiresAt": "2026-10-21T11:00:00.000Z", "format": "csv", "rowCount": 1234,
    "filename": "perceev-acme-answers-2026-07-23-to-2026-10-21.csv" }
  ```
- Errors (`toErrorResponse`): 400 `invalid_request`, 400 `invalid_range`, 401 `unauthenticated`, 403 `cross_site`/`feature_disabled`, 404 `workspace_not_found`, 413 `export_too_large`, 422 `no_rows`, 429 `export_rate_limited`, 503 `storage_unavailable`/`auth_not_configured`/`membership_unavailable`, 500 `internal_error`.
- `Cache-Control: no-store`. `export const maxDuration = 60`. Synchronous (no job, no polling): the row cap keeps it inside the function limit. Not idempotent by design: each call is a new export and counts toward the hourly limit; the client disables the menu while one runs.

### 6.6 UI

#### 6.6.1 Table look (from OpenSEO, unchanged)

`TableCard` (rounded card); toolbar rows `border-b border-border px-4 py-2.5`; header cells `text-muted-foreground`; numeric columns right-aligned `tabular-nums`; selected rows `data-state="selected"`; row actions in the last column with `reveal-on-hover`; pagination footer `border-t px-4 py-3`. Phone: the table scrolls horizontally inside its card (`Table` container `overflow-x-auto`); the page never scrolls sideways; the bulk bar stays centred at the bottom above the safe area.

#### 6.6.2 Export menu

Trigger `Button variant="outline" size="sm"` "Export" with `Download` and a chevron; while busy, a spinner replaces the icon and the trigger is disabled. Items and icons as OpenSEO (§2.9). Scope headers use `DropdownMenuLabel`. Toasts: "No data to export" (error), "Copied data" (copy JSON), "Copied {label}" (copy list), "Could not copy to clipboard" (error).

#### 6.6.3 Scan report (`src/app/portal/scans/[scanId]/page.jsx`)

- The "Download measurement JSON" button inside `data-testid="customer-collection-outcome"` is replaced by `<ExportMenu actions={["json"]} scopes={[{ id: "report", label: "This report", actions: ["json"] }, { id: "questions", label: filtersActive ? "Questions (filtered)" : "Questions", actions: ["sheets", "csv", "excel", "copy-json"] }]} onExport={onExport} />`.
- `onExport(action, scope)`: scope `report` → today's `downloadMeasurement()` (filename `measurement-<scanId>.json`, exact DTO, unchanged code); scope `questions` → `exportRows({ format: action, feature: "scan_report_questions", ...questionExportRows(results, scan.planned_questions, filters), filename: exportFilename([brandKey, "scan", scanId, "questions"]) })`.
- `src/components/portal/scans/reportExport.js` (pure JS, imports `./reportData.js`): `questionExportRows(results, planned, filters: { view, search, engine })` → `{ headers: ["Question", "Engine", "Status", "Names you", "Cited", "Position", "Answer"], rows }`; one row per collected answer in `groupQuestions` order, plus one row per planned engine with no answer (`"Not collected"`, other cells blank); `Status` = "Collection failed" | "Answered" | "No answer"; `Names you`/`Cited` = "Yes"/"No" only when answered, else blank; `Position` number or blank; `Engine` via `engineLabel`; the question set filtered exactly as `QuestionsCard` filters it (same view, search and engine rules, `ReportCards.jsx:186-199`).
- States: while the report loads, the menu is not rendered (the outcome block renders only with a scan, as today).

#### 6.6.4 Scans history (`src/app/portal/scans/page.jsx`)

- The "Scan history" card becomes `DataTable` inside the existing card title/description; toolbar right side: `ExportMenu`.
- Columns: select (`makeSelectionColumn`, row label "Select scan from {date}"); **Date** (`SortableHeader` "Date"; cell `PrefetchLink` to `/portal/scans/<id>` with `prefetch={() => scanReportQueryOptions(id)}`, text `formatDate(scanned_at || created_at, { withTime: true })`); **AI visibility** (`SortableHeader`, `sortingFn: numericNullsLast`; cell: the facade `ProgressBar` exactly as today's `ScanRow` with the percentage or "—"); **Questions** (right); **Naming you** (right, "—" when null); **Engines** (`platformLabel` list); actions (`reveal-on-hover` chevron button "Open report").
- Sorting in the URL with `useUrlSearchState(z.object({ sort: z.enum(["date", "visibility"]), order: z.enum(["asc", "desc"]) }), { sort: "date", order: "desc" })`; `manualSorting` false (20 rows, sorted client-side).
- Row click → `router.push("/portal/scans/<id>")` (as today's `openScan`).
- Loading: `isLoading` → 8 skeleton rows; error with no data → `QueryError` replaces the table (copy "Scans did not load" kept); empty → today's empty card (unchanged).
- Export menu scopes: "Scan history" (`sheets`, `csv`, `excel`, `json`) with headers `Date, AI visibility (%), Questions, Naming you, Engines, Collection` (`AI visibility` blank when null; `Collection` = "Partial" when `collection_partial`, "Complete" when visibility is measured, "Pending" otherwise, via `scanVisibilityState`); and, when `useWorkspace()?.features?.server_exports`, "All answers" with `csv` and `json` labelled "All answers, last 90 days (CSV)" / "(JSON)" → `useServerExport().mutate({ brandKey, kind: "workspace_answers", format, params: { from: today − 89 days, to: today } })`.
- Selection → `TableBulkActionBar selectedLabel="selected"` with `TableBulkExportMenu` (Sheets, CSV, Excel, JSON) exporting only the selected rows with `scope: "selection"`; "Clear selection" resets.
- The failed-runs card and mock-scan panel are unchanged.

### 6.7 Permissions, privacy, observability

- Client exports contain only data already on screen for the signed-in member.
- Server exports: members and owners of the workspace; one-hour signed URLs; objects deleted after 2 hours; the audit row keeps who, when, kind, format, row count and size (no content, no URL).
- Answer text is the customer's own measurement data (already returned by the report route); raw provider payloads are never exported — only `answer_text`, citation URLs from `references` and brand names from `brands`.
- PostHog events (registered with F26 when it exists; emitted through `trackExport`): `data:export { source_feature, format, result_count, scope }`, `data:export_sheets { source_feature, result_count }`, `data:export_server { kind, format, row_count }` (client, on success).
- Logs: §6.2. Never log signed URLs, filenames with dates are fine, never answer text.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/client/components/table/DataTable.tsx` | `src/components/app/table/DataTable.tsx` | COPY | Imports re-pointed; phase-4 `virtualize` prop. |
| `openseo:src/client/components/table/tableSelection.ts` (+ `openseo:src/client/features/rank-tracking/tableSelection.test.ts`) | `src/lib/table/tableSelection.ts` (+ `tableSelection.test.ts`) | COPY | Same three cases under `node --test`. |
| `openseo:src/client/components/table/{DataTableToolbar,TableBulkActionBar,TablePagination,SortableHeader,ScoreBadge}.tsx` | `src/components/app/table/*.tsx` | COPY | — |
| `openseo:src/client/components/table/nullSafeSort.ts` | `src/lib/table/nullSafeSort.ts` (+ test) | COPY | Comparator exported for tests. |
| `openseo:src/client/components/table/url.tsx` (+ `url.test.ts`) | `src/lib/table/url.ts` (+ test), `src/components/app/table/ExternalUrlCell.tsx` | COPY | Split pure helpers from the component. |
| `openseo:src/client/components/table/ExportToSheetsModal.tsx` | `src/components/app/table/ExportToSheetsModal.tsx` | PORT | Next `usePathname`; store module. |
| `openseo:src/client/components/MetricsTable.tsx` | `src/components/app/MetricsTable.tsx` | COPY | — |
| `openseo:src/client/components/ExportMenu.tsx` | `src/components/app/ExportMenu.tsx` | COPY | — |
| `openseo:src/client/lib/csv.ts` (+ test) | `src/lib/export/csv.ts` (+ test) | COPY | Adds `buildExcelCsv` (BOM). |
| `openseo:src/client/lib/clipboard.ts` (+ test) | `src/lib/export/clipboard.ts` (+ test) | COPY | Injectable clipboard for tests. |
| `openseo:src/client/lib/download.ts` | `src/lib/export/download.ts` | COPY | Deferred revoke. |
| `openseo:src/client/lib/exportToSheets.ts` | `src/lib/export/sheetsModalStore.ts`, `exportRows.ts` | PORT | Store split from the action; deps injected. |
| `openseo:src/client/lib/exportRows.ts` (+ test) | `src/lib/export/exportRows.ts` (+ test), `src/components/app/export/useExportRows.ts` | PORT | Deps injected; Excel BOM. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityExport.ts` | `src/lib/export/{serverCsv,serverExport}.ts`, `kinds/workspaceAnswers.ts`, `src/app/api/customer/exports/route.ts` | PORT | R2 + download route → Supabase Storage + signed URL (conventions §4); kind registry; audit table, rate limit, size cap, retention; workspace date range instead of one run. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.test.ts:267-311` | `src/lib/export/exports.route.test.mjs`, `kinds/workspaceAnswers.test.ts` | PORT | Same "one row per answer with its own mentions and citations" assertion; signed-URL shape instead of absolute app URL. |

## 8. Implementation plan

Branches `feat/f06-tables-export-p<N>`.

### Phase 1 — Table and export kits

**Goal:** the table and client export kits exist with their unit tests; the Sheets modal is mounted; nothing uses them yet.

- [x] **P1.T1 Dependencies**
  - [x] **P1.T1.S1** *Files:* `package.json`, `package-lock.json`. *Do:* `npm install @tanstack/react-table@^8.21.3 papaparse@^5.5.3` and `npm install -D @types/papaparse@^5.5.2`. *Verify:* `node -e "import('papaparse').then(m=>console.log(typeof (m.default??m).unparse))"` → `function`.
- [x] **P1.T2 Pure modules**
  - [x] **P1.T2.S1** *Files:* `src/lib/table/{tableSelection,nullSafeSort,url}.ts` and their `*.test.ts`. *Do:* §6.2; tests: OpenSEO's three selection cases (select range from a plain-click anchor; clear range from a deselected anchor; skip `locked`), `compareNumericNullsLast` (`null` last ascending and descending; equal nulls 0), OpenSEO's two URL cases plus `resolveUrlHref("/pricing", "acme.example")` → `https://acme.example/pricing` and no base → `null`. *Verify:* `node --test src/lib/table/` → pass (F06-AC-02 unit, -04, -05).
  - [x] **P1.T2.S2** *Files:* `src/lib/export/{csv,clipboard,download,sheetsModalStore,exportRows,filenames,telemetry}.ts`, `csv.test.ts`, `clipboard.test.ts`, `exportRows.test.ts`, `filenames.test.ts`. *Do:* §6.2; tests: OpenSEO's CSV cases plus `buildExcelCsv` starts with `﻿`; OpenSEO's four clipboard cases with an injected fake clipboard and `ClipboardItem`; OpenSEO's `exportRows` cases (every format refuses zero rows with no side effects; Excel → `'"Keyword"\n"seo audit"'` after the BOM, name `.xls`, event `data:export` with `source_feature`, `format`, `result_count`) plus sheets → `copyTable` then `openSheetsModal(n)` then `data:export_sheets`; copy failure → "Could not copy to clipboard" and no event; `exportFilename(["Acme Co","scan","x/y"])` → `perceev-acme-co-scan-x-y`. *Verify:* `node --test src/lib/export/` → pass (F06-AC-06, -07, -08).
- [x] **P1.T3 Components**
  - [x] **P1.T3.S1** *Files:* `src/components/app/table/{DataTable,DataTableToolbar,TableBulkActionBar,TablePagination,SortableHeader,ScoreBadge,ExternalUrlCell,ExportToSheetsModal}.tsx`, `src/components/app/{MetricsTable,ExportMenu}.tsx`, `src/components/app/export/useExportRows.ts`, `src/components/app/providers/AppProviders.tsx` (mount `<ExportToSheetsModal />`). *Do:* §6.2 React table; licence headers; `"use client"`. *Verify:* `npm run typecheck` → exit 0; `npm run build` → exit 0; `node --test src/lib/brandingGuard.test.mjs` → pass.
  - [x] **P1.T3.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Do:* append the phase's COPY/PORT paths. *Verify:* `git grep -c "src/client/components/table/DataTable.tsx" -- THIRD_PARTY_NOTICES.md` → `1`.

**Checkpoint:** suite, typecheck, build, `check-f04-browser.mjs`, `check-f05-browser.mjs` → pass. Completes F06-AC-04 … -08 and the unit half of -02.

### Phase 2 — Scan report and Scans history

**Goal:** the report's Export menu and the Scans `DataTable` ship with browser coverage.

- [ ] **P2.T1 Report export**
  - [ ] **P2.T1.S1** *Files:* `src/components/portal/scans/reportExport.js`, `src/components/portal/scans/reportExport.test.mjs`. *Do:* §6.6.3; tests with `finalizedReport`-style fixtures built inline: a 3-question, 2-engine plan with one failed row, one unanswered row and one planned engine missing → rows include "Collection failed", "No answer" (blank "Names you"), "Not collected"; filter `{ view: "missing", search: "", engine: "all" }` returns only questions with an answer that does not name the brand; `engine: "chatgpt"` limits rows to ChatGPT; no cell is `0` or `"No"` for an unanswered row. *Verify:* `node --test src/components/portal/scans/reportExport.test.mjs` → pass (F06-AC-10 unit).
  - [ ] **P2.T1.S2** *Files:* `src/app/portal/scans/[scanId]/page.jsx`. *Do:* §6.6.3. *Verify:* `npm run build` → exit 0.
  - [ ] **P2.T1.S3** *Files:* `src/components/portal/portalRegressions.test.mjs`. *Do (reason: the JSON button became an Export menu; the DTO assertion is unchanged):* in `renderCustomerReport` add `["@/components/app/ExportMenu", { ExportMenu: named("ExportMenu") }]` (the `named` helper of the fix branch), `["@/components/app/export/useExportRows", { useExportRows: () => noop }]`, `["@/lib/export/filenames", await import("../../lib/export/filenames.ts")]`, `["@/components/portal/scans/reportExport", await import("./scans/reportExport.js")]` to both report-page module maps; change `download: find(outcome, (node) => node.type === ui.Button)?.props.onClick` to `download: () => find(outcome, (node) => node.type?.name === "ExportMenu")?.props.onExport("json", "report")`. *Verify:* `node --test src/components/portal/portalRegressions.test.mjs` → pass ("R05 customer report download is the exact report DTO the page rendered" still asserts `measurement-<id>.json` and the same body).
- [ ] **P2.T2 Scans table**
  - [ ] **P2.T2.S1** *Files:* `src/app/portal/scans/page.jsx`, `src/components/portal/scans/scans.css` (drop `pv-table` rules). *Do:* §6.6.4. *Verify:* build → exit 0.
  - [ ] **P2.T2.S2** *Files:* `src/components/portal/tenantWorkspace.test.mjs`. *Do (reason: the page imports the table and export kits; assertions unchanged):* in "tenant Scans renders a runnable mock…" add `autoStub: [..., "@/components/app/table/", "@/components/app/ExportMenu", "@/components/app/export/"]` and `["@/lib/export/filenames", await import("../../lib/export/filenames.ts")]`, `["zod", await import("zod")]`, `["@/components/app/hooks/useUrlSearchState", { useUrlSearchState: (_s, d) => [d, () => {}] }]`. *Verify:* `node --test src/components/portal/tenantWorkspace.test.mjs` → pass.
- [ ] **P2.T3 Browser checks**
  - [ ] **P2.T3.S1** *Files:* `scripts/qa/check-f06-browser.mjs` (new), `tests/fixtures/portal/{scans-acme-history.json,scans-acme-error.json}` (new; 12 scans, 2 with `visibility_pct: null`), `.github/workflows/ci.yml` (run after `check-f05-browser.mjs`). *Do:* with `openPortal`, context permissions `clipboard-read`, `clipboard-write`:
    - `F06-B01` delay `/api/customer/scan` 1 s → during the delay the scans table shows the six header cells and exactly 8 skeleton rows; with `scans-acme-error.json` (500) and no cached data → the error card replaces the table and no `<table>` is present.
    - `F06-B02` click the checkbox of row 2, shift-click row 6 → rows 2–6 selected, bulk bar "5 selected"; shift-click row 4 after plain-clicking row 4 off → rows 2–6 minus the cleared range per anchor rule (assert against `applyShiftRangeSelection` expectations); "Clear selection" hides the bar; select 3 rows → bulk Export → CSV → the downloaded file has a header plus 3 lines.
    - `F06-B03` Export → "Export to Sheets" → modal "Copied 12 rows to your clipboard"; clipboard text starts with `Date\tAI visibility (%)`; clicking "Open new Google Sheet" opens a popup whose URL starts with `https://sheets.new` (popup aborted by the harness route guard, which counts it, not a failure); navigating to `/portal` closes the modal.
    - `F06-B04` on `/portal/scans/scan-1`: Export → "Download JSON" downloads `measurement-scan-1.json` equal to the fixture body; Export → Questions → CSV downloads a file whose rows include `"Not collected"`; scans list Export → CSV: unmeasured scans have an empty AI visibility cell.
    - `F06-B05` click the "AI visibility" header → URL gains `?order=desc&sort=visibility` (sorted keys), null rows are last; click again → `order=asc`, null rows still last; reload keeps the order; hovering a date link sends one `GET /api/customer/scan/report/<id>`.
    - `blockedWrites` stays 0.
    *Verify:* local `next start -p 3328` with CI's placeholder env → all pass (F06-AC-01, -02, -03, -09, -10, -11).

**Checkpoint:** suite, typecheck, build, browser checks F04/F05/F06, public browser → pass. Completes F06-AC-01, -02, -03, -09, -10, -11.

### Phase 3 — Server-side export

**Goal:** large answer exports are built on the server behind `FEATURE_SERVER_EXPORTS`, stored privately and cleaned up.

- [ ] **P3.T1 Database**
  - [ ] **P3.T1.S1** *Files:* `supabase/migrations/065_f06_exports.sql`. *Do:* §6.1 exactly. *Verify:* apply twice to a disposable `*_qa` database (`scripts/qa/check-repair-workflows.mjs` pattern) → both exit 0.
  - [ ] **P3.T1.S2** *Files:* `scripts/setup-supabase.mjs`. *Do:* add `"065_f06_exports.sql": [{ kind: "bucket", name: "exports" }, { kind: "table", name: "export_requests" }, { kind: "index", name: "export_requests_brand_created_idx" }, { kind: "index", name: "export_requests_cleanup_idx" }, { kind: "constraint", name: "export_requests_kind_ck" }, { kind: "constraint", name: "export_requests_format_ck" }, { kind: "constraint", name: "export_requests_status_ck" }, { kind: "constraint", name: "export_requests_counts_ck" }, { kind: "constraint", name: "export_requests_path_ck" }]`. *Verify:* `node --test src/lib/migrationsLedger.test.mjs` → pass.
  - [ ] **P3.T1.S3** *Files:* `README.md` (migration table row `` `065_f06_exports` `` — "F06 server exports: private `exports` bucket and `export_requests` audit table"), `docs/OPERATOR_LEDGER.md` § C (add `` `065_f06_exports` `` to the enumeration), `docs/PROD_MIGRATIONS.md` (bullet `` `065_f06_exports.sql` ``: what it adds, that it is additive, and that no policy exposes the bucket). *Verify:* `node --test src/lib/docStatus.test.mjs` → pass.
  - [ ] **P3.T1.S4** *Files:* `tests/customer-uat.sql`, `scripts/qa/check-f06-db.mjs` (new). *Do:* UAT block: insert one `export_requests` row for each of the two fixture brands used by the file; as user `…0001` `SELECT count(*)` → 1; as `…0002` → 1; as `anon` → permission denied. DB script: bucket `exports` exists, `public = false`, `file_size_limit = 26214400`, MIME list equals `{text/csv,application/json}`; no `storage.objects` policy mentions `exports`; constraint `export_requests_path_ck` rejects `storage_path = 'other/x'` for brand `acme`. *Verify:* CI `customer-database` job commands locally → pass (F06-AC-14).
- [ ] **P3.T2 Server modules and route**
  - [ ] **P3.T2.S1** *Files:* `src/lib/features/names.ts` (append `server_exports: { spend: [] as const }`), `src/lib/features/clientFeatures.ts` (append `"server_exports"`), `src/lib/export/{serverCsv,serverExport,retention}.ts`, `src/lib/export/kinds/{index,workspaceAnswers}.ts`, `src/lib/export/exports.contract.ts`, `src/app/api/customer/exports/route.ts`, `src/lib/jobs/kinds.ts` (one import line for `../export/retention.ts`). *Do:* §6.2, §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass; `npm run typecheck` → exit 0.
  - [ ] **P3.T2.S2** *Files:* `src/lib/export/serverCsv.test.ts`, `src/lib/export/kinds/workspaceAnswers.test.ts`. *Do:* `serverCsvCell("  =SUM(A1)")` → `"'  =SUM(A1)"` quoted; `"\tx"` guarded; `null` → `""`; inner quotes doubled; lines joined by `\r\n`; `toCsvRow` for: answered + mentioned + cited (`yes`, `yes`), answered not mentioned (`no`, `no`), unanswered (`no_answer`, blanks), failed (`failed`, blanks), citations with `javascript:` and duplicates removed, `brands_named` only mentioned brands; header order exactly §6.2; JSON shape keys. *Verify:* `node --test src/lib/export/serverCsv.test.ts src/lib/export/kinds/workspaceAnswers.test.ts` → pass (F06-AC-13).
  - [ ] **P3.T2.S3** *Files:* `src/lib/export/exports.route.test.mjs` (customer route hook pattern, fake admin with in-memory `scans`, `prompt_results`, `export_requests`, and a fake Storage recording `upload`, `createSignedUrl(path, ttl, { download })`, `remove`). *Do:* cases: flag off → 403 `feature_disabled`, no insert; extra body key → 400; `to` before `from`, span 93 days, future `to` → 400 `invalid_range`; 20 prior rows in the last hour → 429, no insert; no scans in range → 422, row `failed`/`no_rows`; 50,001 rows → 413, no upload, row `failed`; success → upload path `acme/workspace_answers/<id>.csv`, content type `text/csv; charset=utf-8`, `createSignedUrl` called with `(path, 3600, { download: "perceev-acme-answers-…csv" })`, row `ready` with counts, response matches the contract; a scan of brand `beta` in the same date range is not in the file; upload failure → 503 and row `failed`; no `console.*` call contains `token=` or answer text (spy on console). *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/export/exports.route.test.mjs` → pass (F06-AC-12).
  - [ ] **P3.T2.S4** *Files:* `src/lib/export/retention.test.ts`. *Do:* with fakes: rows at now−3 h, now−1 h, now−91 days; run → Storage `remove` called with the first and third paths (batched ≤ 100), those rows `deleted`; the 91-day row then pruned; the 1-hour row untouched; Storage error on one batch leaves those rows untouched and logs the count. *Verify:* `node --test src/lib/export/retention.test.ts` → pass (F06-AC-15).
- [ ] **P3.T3 Client**
  - [ ] **P3.T3.S1** *Files:* `src/components/app/export/useServerExport.ts`, `src/app/portal/scans/page.jsx` (server scope behind `features.server_exports`). *Do:* §6.6.4. *Verify:* build → exit 0; `check-f06-browser.mjs` extended with `F06-B06`: features fixture `{ server_exports: true }`, the route fixture returns the §6.5 example with `url` pointing at `http://127.0.0.1:3328/__qa/download.csv` (fulfilled by the harness) → the browser navigates to it once and the toast "Export ready. Your download has started." appears; with `{ server_exports: false }` the "All answers" scope is absent.

**Checkpoint:** suite, typecheck, build, DB checks, browser checks → pass. `.env.example` gains `FEATURE_SERVER_EXPORTS=` and `FEATURE_SERVER_EXPORTS_BRANDS=` (names only). Completes F06-AC-12 … -15.

### Phase 4 (optional) — Virtualization

**Goal:** long unpaginated tables render only visible rows. Build only when the first consumer (F13 saved keywords or F15 rank tracking) needs more than 200 rows on one page.

- [ ] **P4.T1** *Files:* `package.json` (`@tanstack/react-virtual@^3.13.0`), `src/lib/table/virtualWindow.ts`, `virtualWindow.test.ts`, `src/components/app/table/DataTable.tsx` (prop `virtualize?: { rowHeight: number; overscan?: number /* default 8 */ }`, active when set and `rows.length > 200`: the body renders a top spacer row of `padTop` px, rows `start…end`, a bottom spacer of `padBottom` px; header stays sticky; requires `scrollClassName`). *Do:* `virtualWindow` cases: top of list, middle, end, `rowCount` smaller than the window, overscan clamped at both ends. *Verify:* `node --test src/lib/table/virtualWindow.test.ts` → pass (F06-AC-16); the consumer spec's browser test asserts fewer than 80 `<tr>` elements for 500 rows.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/table/tableSelection.test.ts` | OpenSEO's three cases | 02 |
| `src/lib/table/nullSafeSort.test.ts` | nulls last both directions | 04 |
| `src/lib/table/url.test.ts` | fragments, schemes, relative paths | 05 |
| `src/lib/export/csv.test.ts` | rounding, quoting, injection, BOM | 06 |
| `src/lib/export/clipboard.test.ts` | TSV, HTML links, injection, escaping | 07 |
| `src/lib/export/exportRows.test.ts`, `filenames.test.ts` | zero rows, Excel, sheets order, copy failure, events; filenames | 08 |
| `src/components/portal/scans/reportExport.test.mjs` | rows, not-collected, blanks, filters | 10 |
| `src/components/portal/portalRegressions.test.mjs` (updated) | exact JSON DTO through the menu | 10 |
| `src/lib/export/serverCsv.test.ts`, `kinds/workspaceAnswers.test.ts` | server CSV and mapping | 13 |
| `src/lib/export/exports.route.test.mjs` | flag, validation, range, rate, empty, size, success, isolation, storage failure, no secret logging | 12 |
| `src/lib/export/retention.test.ts` | removal, prune, partial failure | 15 |
| `tests/customer-uat.sql`, `scripts/qa/check-f06-db.mjs` | RLS, bucket, constraint | 14 |
| `scripts/qa/check-f06-browser.mjs` | B01–B06 | 01, 02, 03, 09, 10, 11 |
| `src/lib/table/virtualWindow.test.ts` (phase 4) | window math | 16 |

Fixtures: invented scans and answers under `tests/fixtures/portal/`; server tests use in-memory fakes; no live Storage or provider calls.

## 10. Rollout and rollback

- **Env vars (names only):** `FEATURE_SERVER_EXPORTS`, `FEATURE_SERVER_EXPORTS_BRANDS`.
- **Flag default:** unset → off in production (F01 semantics); on in development. Client-side exports are always available.
- **Migration order:** apply `065_f06_exports.sql` before deploying phase 3; it is additive.
- **Owner steps to enable server exports:** apply 065 in production; set `FEATURE_SERVER_EXPORTS=allowlist` and `FEATURE_SERVER_EXPORTS_BRANDS=<brand keys>`; check one export from the Scans page; then `on`.
- **Turn off:** `FEATURE_SERVER_EXPORTS=off` (the menu scope disappears; the route returns 403). Existing links expire within an hour; objects are removed within 2 hours by retention.
- **Rollback:** revert phase 2 to restore the old report button and scans table; revert phase 3 and leave 065 in place (unused table and empty bucket are harmless).

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | Excel opens a CSV named `.xls` with a format warning (OpenSEO accepts this). | Keep OpenSEO's approach; add a UTF-8 BOM so non-ASCII brand names display correctly (deviation 1). |
| 2 | A signed URL works for anyone holding it for one hour. | Same exposure as OpenSEO's time-limited link but without re-checking the session; mitigated by the 1-hour expiry, object deletion after 2 hours, never logging URLs, and `download` disposition. Owner may ask for an authenticated download route later. |
| 3 | Synchronous export could exceed the function time on slow databases. | 50,000-row cap, 500-scan cap, 92-day range, `maxDuration = 60`; if real exports approach the limit, move the kind to an F01 job (the registry shape allows it). |
| 4 | `prompt_results.raw` may hold citations under `url` instead of `href` for some engines. | Read `href ?? url`; unsafe or missing URLs are dropped, never invented. |
| 5 | Clipboard permissions differ by browser (Safari needs a user gesture). | Export runs inside the menu click handler; failures toast "Could not copy to clipboard". |
| 6 | The first consumer of selection (Scans) has only 20 rows, so range select is modest there. | Kept for parity and test coverage; F13/F15 use it at scale. |

## 12. Definition of done

- [ ] Phases 1–3 merged (phase 4 when a consumer needs it); subtasks ticked.
- [ ] F06-AC-01 … F06-AC-15 covered by passing tests or recorded browser runs (AC-16 with phase 4).
- [ ] `npm test`, `npm run typecheck`, `npm run build` green; `check-f06-browser.mjs` and DB checks in CI.
- [ ] Migration ledgers (setup registry, README, OPERATOR_LEDGER § C, PROD_MIGRATIONS) list 065.
- [ ] `THIRD_PARTY_NOTICES.md` updated; `features/README.md` status updated; owner-run enablement result recorded when the flag is turned on.

## Deviations from conventions

1. **Excel export adds a UTF-8 BOM** (OpenSEO's has none) so non-ASCII text survives Excel; CSV stays BOM-free like OpenSEO's.
2. **Server exports are synchronous** (no F01 job and no `202`/polling), as OpenSEO's are; the caps in risk 3 keep them inside a function call. Conventions §9 "long work returns 202" does not apply under these caps.
3. **Download is a Supabase signed URL** rather than an authenticated app route (conventions §4 maps OpenSEO's R2 export link to "Storage bucket `exports` with signed URLs").
