# F12 — Question detail and answer history

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F12 |
| Wave | 1 |
| Comparison rows covered | "Answer detail view" (OpenSEO: per-prompt page with the answer per engine and date, highlighted brand-mention excerpts, Citations and Brands side tabs; Perceev: scan report lists each question's answers, no per-question history page) |
| Depends on | F05 (`QueryClient`), F04 (UI primitives, app shell), **F08** (`workspace_questions` and the SQL normaliser `public.normalize_question_text(text)`, see §11), F01 (`requireWorkspace`, errors, periodics). Optional: F02 (stores `answer_markdown` for DataForSEO answers), F11 (explore answers appear in history when F11 is merged). `features/README.md` lists only F05; F08 must be added there (§11). |
| Blocks | F23 (reports may embed a question's history), F22 (assistant tool `get_question_history`) |
| Reserved migrations | 095–099. **095** `095_f12_question_answer_links.sql`. 096–099 unused. |
| Feature flag | none. This is a read-only view of data the workspace already owns; it makes no provider calls. |
| Spend features | none |
| OpenSEO reference | `openseo:src/routes/_app/p/$projectId/ai-visibility/prompts/$promptId.tsx`, `openseo:src/client/features/ai-visibility/{PromptHistoryPage,PromptAnalysis,PromptDateRange,PromptSummary,PromptAnswers,AnswerContent,PromptExecutions,shared}.tsx`, `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.ts`, `openseo:src/shared/ai-visibility-results.ts`, `openseo:src/server/features/ai-visibility/services/aiVisibilityMatching.ts` at `c5f8db1` |

## 1. Summary

Each tracked question gets its own page at `/portal/questions/[questionId]`. It shows how often every brand was named and cited over a chosen period, every answer collected for the question across all scans and panel versions, and, for the selected engine and date, the full answer rendered as markdown with its citations, the brands it named and highlighted excerpts where each brand appears. Customers stop scrolling scan reports to see how one question has changed over time; the page also exposes Perceev's stronger evidence (aliases, sentiment, private raw captures) where OpenSEO only has markdown.

## 2. What OpenSEO does (observed)

1. Route `/_app/p/$projectId/ai-visibility/prompts/$promptId` prefetches the prompt's history and renders `PromptHistoryPage` keyed by project and prompt (`openseo:src/routes/_app/p/$projectId/ai-visibility/prompts/$promptId.tsx:1-26`).
2. History is read with `includeHistory: true, branded: "all"`: every answer of the latest **50** project runs for that prompt, "so engine ordering cannot hide a newer execution from the selector" (`openseo:src/client/features/ai-visibility/shared.tsx:97-109`; server `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.ts:91-168`, `:194-203`). `truncated` is true when 50 runs were read (`aiVisibilityResults.ts:165`).
3. Page header: back link "All tracked prompts", title = prompt text (`whitespace-pre-wrap`, `data-ph-mask`), or the text retained on the latest run when the prompt was deleted, or "Prompt analysis"; description "{topic} · Prompt analysis"; a "Run now" button with a cost review (`openseo:src/client/features/ai-visibility/PromptHistoryPage.tsx:19-124`).
4. Date range: presets "Last 7 days", "Last 28 days" (default), "Last 90 days", "All available history", "Custom range" with two date inputs and the error "Choose a start date on or before the end date."; filtering uses the answer's collection time, else the run's creation time, in local days (`openseo:src/client/features/ai-visibility/PromptDateRange.tsx:11-128`; `PromptAnalysis.tsx:42-53`).
5. Executions are sorted newest run first; the selected execution defaults to the newest answered one (`openseo:src/client/features/ai-visibility/PromptAnalysis.tsx:44-63`).
6. "Brand comparison" table: Brand / Mentioned / Cited, your brand first with a "You" badge, then by mentions and citations; rates show "{x} of {y}"; only 4 rows until "Show {n} more"; empty row "No brand evidence is available for this period yet." (`openseo:src/client/features/ai-visibility/PromptSummary.tsx:17-106`). Rates count only answered collections (`openseo:src/shared/ai-visibility-results.ts:8-44`).
7. "Answer" section with two selects: AI provider, then date; switching provider keeps the same run when that provider answered it (`PromptAnalysis.tsx:124-198`). "Collected prompt: {text}" when it differs from the current text (`openseo:src/client/features/ai-visibility/PromptAnswers.tsx:32-39`). Non-completed answers show "{Engine} · {status}" and "This collection is excluded from visibility rates." (`PromptAnswers.tsx:40-61`).
8. Answer evidence: no-answer notes ("Google showed no AI Overview for this search." / "No substantive answer was returned." + "This collection is excluded from visibility rates."), error text, truncation note "This response was truncated. The retained evidence may be incomplete."; the markdown answer with images replaced by "[Image: alt]"; an aside with tabs "Citations ({n})" and "Brands"; on small screens a button group Answer / Citations / Brands (`openseo:src/client/features/ai-visibility/AnswerContent.tsx:35-269`).
9. Brands tab: "Mentions appear in the answer text. Citations link to the brand’s domain."; per brand Mentioned/Not mentioned and Cited/Not cited badges; an accordion "Mention excerpts ({n})" showing 70 characters either side of each span with the span in `<mark>` (`AnswerContent.tsx:182-254`). Spans are computed on read from the plain text (`aiVisibilityResults.ts:273-283`) with a Unicode-safe matcher that ignores URLs and e-mail addresses (`openseo:src/server/features/ai-visibility/services/aiVisibilityMatching.ts:12-63`).
10. Answers are cut to 24,000 characters for display (`aiVisibilityResults.ts:205`, `:253-288`).
11. "Executions" list: header with "{n} in this period"; columns Date / Engine / Brand mentioned / Owned citation; trigger tag "Baseline"/"Scheduled"; non-answered rows show a status badge; selected row `aria-pressed` (`openseo:src/client/features/ai-visibility/PromptExecutions.tsx:17-108`).
12. Empty: "No executions in this period" + "Choose another date range to see this prompt’s answers." + "Show all available history", or "No answers yet" + "Choose Run now to collect answers, brand mentions, and citations."; truncation note "History covers the latest 50 project runs. Older executions are not included in this period’s metrics." (`PromptAnalysis.tsx:91-120`).
13. Rates use `aiRate(count, eligible)` → "—" when eligible is 0; dates via `toLocaleString()` (`openseo:src/client/features/ai-visibility/shared.tsx:198-206`).
14. Brand identity is snapshotted per match row (name, domain), so later brand edits do not rewrite history (teardown, "Brand snapshot stored with every match").

## 3. What Perceev has today

- **Answers.** Scan answers are `probe_observations` rows (`supabase/migrations/027_durable_probe_dispatch.sql:3-26`), each with `result` jsonb written by `finish_probe_dispatch`: `text`, `references`, `citations`, `brand_mentioned_in_text`, `brand_cited`, `competitors_found_in_text`, `competitors_cited`, `brands[]` (`name, is_self, mentioned, position, relationship, sentiment, sentiment_label, spans`, from `judgeBrandsSymmetric`, `src/lib/scoring/judge.js:305-322`), `entity_evidence` (`mention_state`, `mentioned`, `spans[{start,end,text,alias,source}]`, `cited`, `citation_evidence`, from `src/lib/scoring/entityEvidence.js:17-60`), `provenance` (`src/lib/provenance.js:87-140`), `measurement_method`, `serp_state`, `aio_present`, `evidence_state`, `evidence_captures`, `error`. They are projected into `prompt_results` keyed by `(job_id, engine, query)` (`027:255-267`); older scans have only `prompt_results` rows (`supabase/migrations/005_analytics_platform.sql:8-27`). Stored spans index into `result.text`, so excerpts need no recomputation and keep the brand identity used at judging time.
- **Identity.** A question is only its text. Panels are versioned `repair_artifacts` (`supabase/migrations/029_repair_workflow.sql:1-35`) frozen onto `scan_jobs.panel_snapshot` (`supabase/migrations/032_durable_schedule_windows.sql:2`, `:36-46`). Observation ids hash `{jobId, engine, query}` (`src/lib/workers/durableProbing.js:116-128`); nothing ties two scans' answers to one question. F08 introduces `workspace_questions` (stable id, `text_normalized` unique per brand) and question ids in panel versions.
- **Customer reads.** `GET /api/customer/scan/report/[scan_id]` returns `prompt_results` rows for one scan (`src/app/api/customer/scan/report/[scan_id]/route.js:11-72`); the report groups them by lower-cased question text (`src/components/portal/scans/reportData.js:180-202`) and renders each question with its engine answers (`src/components/portal/scans/ReportCards.jsx:143-270`). `GET /api/customer/measurement` lists observation metadata and capture states, deriving `withdrawn` from `reason = 'redaction_retracted'` and `expired` from `expires_at` (`src/app/api/customer/measurement/route.js:15-61`). `GET /api/customer/measurement/evidence` checks ownership through `scan_jobs`, returns 410 with "This capture was withdrawn because its redaction could not be verified. The measurement is retained." or "Raw capture expired under the retention policy. The measurement is retained.", and redirects to a signed URL valid at most 120 s (`src/app/api/customer/measurement/evidence/route.js:6-54`).
- **Tables are service-only.** `probe_observations` and `measurement_evidence` have no customer grants (`027:59-64`, `028:19-22`); `prompt_results` has a tenant read policy on `brand` (`supabase/migrations/023_customer_auth_and_tenant_rls.sql:146-165`). Scheduled scans are identifiable by `measurement_windows.job_id` (`032:4-9`).
- **Missing:** per-question identity across scans, a history page, date ranges, cross-scan brand rates per question, and links from the Questions page and the scan report.
- **Must not break:** scan report markup and its tests (`src/components/portal/portalRegressions.test.mjs`), the evidence route's status codes and copy, P0 tables (F12 only reads them), Mixed rows "Stable question set" and "Trend comparability" (F12 shows per-question history; it computes no trend deltas).

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F12-AC-01 | `question_answer_links` exists with tenant RLS; a member of workspace A cannot read B's links. | DB `scripts/qa/check-f12-db.mjs` group `links-rls`; CI tenant test |
| F12-AC-02 | `link_question_answers(brand)` links each **terminal** scan observation of that workspace to a question: first by the `question_id` carried in the scan's frozen panel snapshot whose text matches, else by `normalize_question_text(query)`; it fills `prompt_result_id`, `scan_job_id`, `scan_id`, `collected_at`; it is idempotent and never links a non-terminal (`pending`, `leased`, `retry`, `posted`) row. | DB group `link-scan` |
| F12-AC-03 | It links explore observations by their own `brand_key` and legacy `prompt_results` rows that have no observation; it never links across workspaces. | DB group `link-explore-legacy` |
| F12-AC-04 | With `p_import_missing = true`, every distinct historical question text without a question becomes one `workspace_questions` row (`origin 'import'`, `status 'archived'`, `topic 'General'`) and is then linked; repeat runs create nothing. | DB group `link-import` |
| F12-AC-05 | Links are created by the periodic `questions.link` job (every 300 s) and lazily before a history read (bounded to 500 rows); a failing lazy link does not fail the read. | unit `src/lib/questions/history/history.test.ts`; DB group `link-scan` |
| F12-AC-06 | `GET /api/customer/questions/[questionId]/history` returns 404 for an unknown question or another workspace's; filters by `from`/`to` on `collected_at`; sorts newest first; returns at most 500 executions with `truncated`; contains no answer text. | route `src/lib/questions/history/history.route.test.mjs` |
| F12-AC-07 | Brand summary: counts only scan and legacy answers with an answer (`explore` excluded); per brand `answers` = answered executions whose roster included it with a known mention state; `unknown` counts null mention states and is excluded from the denominator; your brand's citation = `brand_cited`, a rival's = its name in `competitors_cited`. Matches OpenSEO `summarizeAiBrands` on an equivalent fixture. | unit `src/lib/questions/history/summary.test.ts` |
| F12-AC-08 | `GET /api/customer/questions/[questionId]/answers/[answerId]` returns the answer (markdown when stored, else text, cut to 24,000 chars with `truncated`), safe citations only, brands with stored spans (no recomputation; spans outside the text dropped), provenance, and capture states (`stored`, `expired`, `withdrawn`, `incomplete`, `legacy_unknown`); an evidence link only for stored, unexpired, non-withdrawn captures; 404 for another workspace. | route test |
| F12-AC-09 | `GET /api/customer/measurement/evidence` also serves explore observations owned by the workspace (`purpose = 'explore'` and `brand_key`), with the existing 404/409/410 copy unchanged for scan observations. | route `src/lib/questions/history/evidenceRoute.route.test.mjs` |
| F12-AC-10 | The page renders every state in §6.6 with the exact copy; changing the date range, engine or date updates the URL; back/forward restores them. | browser `scripts/qa/check-f12-browser.mjs` |
| F12-AC-11 | The scan report shows a "History" link on every question row that has a linked question, pointing to `/portal/questions/{id}?from=scan&scan={scanId}`; rows without a link show no link; existing report tests pass. | unit `src/components/portal/scans/reportHistoryLinks.test.mjs`; `src/components/portal/portalRegressions.test.mjs` |
| F12-AC-12 | `questions.links.retention` deletes links older than 395 days in batches and never touches P0 rows. | DB group `links-retention` |
| F12-AC-13 | Notices link earlier and newer wordings through `workspace_questions.replaced_by`. | route test; browser test |
| F12-AC-14 | No answer text, question text or excerpt is logged or sent to telemetry; the page marks question and answer text with `data-ph-mask`. | unit spies in `history.test.ts`; browser assertion on the attribute |

## 5. Scope

**In scope:** the link table and linking (including backfill of existing observations), the two read routes, the evidence route extension for explore answers, the history page, links from the scan report and the Questions page, retention.

**Out of scope:**
- Creating or editing questions, panels and statuses (F08). F12's only write to `workspace_questions` is the optional archived import in the backfill (§6.1), requested from F08 as the same rule.
- Running a question from this page: OpenSEO's "Run now" is per-prompt scan collection; ours scans whole panels (F09/F10). The page links to the latest scan instead.
- Trend deltas and comparison states (Mixed row "Trend comparability", deferred).
- Citation source analysis across questions (Mixed row "Citations and sources", deferred); the Citations tab lists one answer's sources only.
- Prompt Explorer (F11); its answers are listed when present.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/095_f12_question_answer_links.sql`

```sql
-- F12: stable link from every collected answer to the workspace question it answered,
-- across scans, panel versions, Prompt Explorer and legacy prompt_results rows.
-- P0 tables are read only. Requires F08 (workspace_questions, normalize_question_text).

DO $$ BEGIN
  IF to_regclass('public.workspace_questions') IS NULL
     OR to_regprocedure('public.normalize_question_text(text)') IS NULL THEN
    RAISE EXCEPTION 'F12 requires F08: workspace_questions and normalize_question_text(text)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.question_answer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.workspace_questions(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('scan','explore','legacy')),
  observation_id text UNIQUE REFERENCES public.probe_observations(id) ON DELETE CASCADE,
  prompt_result_id uuid UNIQUE REFERENCES public.prompt_results(id) ON DELETE CASCADE,
  scan_job_id uuid,                       -- scan_jobs.id (scan and legacy rows)
  scan_id uuid,                           -- scans.id once the scan finalized
  explore_run_id uuid,                    -- explore_runs.id (F11), no FK: runs are pruned after 13 months
  engine text NOT NULL,
  asked_text text NOT NULL,               -- exact text asked; may differ from the question's current text
  collected_at timestamptz NOT NULL,
  linked_by text NOT NULL CHECK (linked_by IN ('backfill','periodic','read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_answer_links_target CHECK (observation_id IS NOT NULL OR prompt_result_id IS NOT NULL),
  CONSTRAINT question_answer_links_source_shape CHECK (
    (source = 'scan' AND observation_id IS NOT NULL AND scan_job_id IS NOT NULL)
    OR (source = 'explore' AND observation_id IS NOT NULL AND explore_run_id IS NOT NULL)
    OR (source = 'legacy' AND observation_id IS NULL AND prompt_result_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS question_answer_links_question_idx
  ON public.question_answer_links (question_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS question_answer_links_brand_idx
  ON public.question_answer_links (brand_key, collected_at DESC);
CREATE INDEX IF NOT EXISTS question_answer_links_scan_idx
  ON public.question_answer_links (scan_id) WHERE scan_id IS NOT NULL;
ALTER TABLE public.question_answer_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.question_answer_links TO authenticated;
GRANT ALL ON public.question_answer_links TO service_role;
DROP POLICY IF EXISTS question_answer_links_read ON public.question_answer_links;
CREATE POLICY question_answer_links_read ON public.question_answer_links FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

CREATE OR REPLACE FUNCTION public.link_question_answers(p_brand text, p_limit integer DEFAULT 2000,
  p_import_missing boolean DEFAULT false, p_linked_by text DEFAULT 'periodic')
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_scan integer := 0; v_explore integer := 0; v_legacy integer := 0; v_imported integer := 0; v_unmatched integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN RAISE EXCEPTION 'invalid link limit'; END IF;
  IF p_linked_by NOT IN ('backfill','periodic','read') THEN RAISE EXCEPTION 'invalid linker'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_brands WHERE brand_key = p_brand) THEN RAISE EXCEPTION 'unknown workspace'; END IF;

  IF p_import_missing THEN
    INSERT INTO workspace_questions(brand_key, text, topic, origin, status, branded)
    SELECT p_brand, src.text, 'General', 'import', 'archived', coalesce(src.branded, false)
      FROM (
        SELECT DISTINCT ON (normalize_question_text(t.text)) t.text, t.branded
          FROM (
            SELECT o.query AS text, (o.result->>'is_branded_query')::boolean AS branded, o.created_at
              FROM probe_observations o JOIN scan_jobs j ON j.id = o.job_id
             WHERE j.brand_key = p_brand AND o.purpose = 'scan'
            UNION ALL
            SELECT r.query, r.is_branded_query, r.created_at FROM prompt_results r WHERE r.brand = p_brand
          ) t
         WHERE btrim(t.text) <> ''
         ORDER BY normalize_question_text(t.text), t.created_at
      ) src
     WHERE NOT EXISTS (SELECT 1 FROM workspace_questions q
                        WHERE q.brand_key = p_brand AND q.text_normalized = normalize_question_text(src.text))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_imported = ROW_COUNT;
  END IF;

  -- 1. Terminal scan observations. Prefer the question id frozen in the scan's panel snapshot.
  WITH cand AS (
    SELECT o.id, o.job_id, o.engine, o.query, coalesce(o.observed_at, o.created_at) AS at, j.result_id AS scan_id,
           coalesce(
             (SELECT q.id FROM jsonb_array_elements(coalesce(j.panel_snapshot->'payload'->'prompts', '[]'::jsonb)) e
                JOIN workspace_questions q ON q.id::text = e->>'question_id' AND q.brand_key = p_brand
               WHERE normalize_question_text(e->>'text') = normalize_question_text(o.query) LIMIT 1),
             (SELECT q.id FROM workspace_questions q
               WHERE q.brand_key = p_brand AND q.text_normalized = normalize_question_text(o.query) LIMIT 1)
           ) AS question_id
      FROM probe_observations o JOIN scan_jobs j ON j.id = o.job_id
     WHERE j.brand_key = p_brand AND o.purpose = 'scan'
       AND o.state IN ('answered','valid_no_aio','failed','ambiguous','blocked')
       AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.observation_id = o.id)
  )
  INSERT INTO question_answer_links(brand_key, question_id, source, observation_id, prompt_result_id,
                                    scan_job_id, scan_id, engine, asked_text, collected_at, linked_by)
  SELECT p_brand, c.question_id, 'scan', c.id,
         (SELECT r.id FROM prompt_results r WHERE r.job_id = c.job_id AND r.engine = c.engine AND r.query = c.query LIMIT 1),
         c.job_id, c.scan_id, c.engine, c.query, c.at, p_linked_by
    FROM (SELECT * FROM cand WHERE question_id IS NOT NULL ORDER BY at LIMIT p_limit) c
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_scan = ROW_COUNT;

  -- 2. Explore observations (F11) of this workspace.
  INSERT INTO question_answer_links(brand_key, question_id, source, observation_id, explore_run_id,
                                    engine, asked_text, collected_at, linked_by)
  SELECT p_brand, q.id, 'explore', o.id, (o.context->>'explore_run_id')::uuid, o.engine, o.query,
         coalesce(o.observed_at, o.created_at), p_linked_by
    FROM probe_observations o
    JOIN workspace_questions q ON q.brand_key = p_brand AND q.text_normalized = normalize_question_text(o.query)
   WHERE o.purpose = 'explore' AND o.brand_key = p_brand
     AND o.state IN ('answered','failed','ambiguous','blocked')
     AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.observation_id = o.id)
   ORDER BY o.created_at LIMIT p_limit
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_explore = ROW_COUNT;

  -- 3. Legacy prompt_results with no observation (scans before durable dispatch).
  INSERT INTO question_answer_links(brand_key, question_id, source, prompt_result_id, scan_job_id, scan_id,
                                    engine, asked_text, collected_at, linked_by)
  SELECT p_brand, q.id, 'legacy', r.id, r.job_id, r.scan_id, r.engine, r.query, coalesce(r.created_at, now()), p_linked_by
    FROM prompt_results r
    JOIN workspace_questions q ON q.brand_key = p_brand AND q.text_normalized = normalize_question_text(r.query)
   WHERE r.brand = p_brand
     AND NOT EXISTS (SELECT 1 FROM probe_observations o WHERE o.job_id = r.job_id AND o.engine = r.engine AND o.query = r.query)
     AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.prompt_result_id = r.id)
   ORDER BY r.created_at LIMIT p_limit
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_legacy = ROW_COUNT;

  -- 4. Late scan_id: links created before the scan finalized.
  UPDATE question_answer_links l SET scan_id = j.result_id
    FROM scan_jobs j WHERE l.brand_key = p_brand AND l.scan_id IS NULL AND l.scan_job_id = j.id AND j.result_id IS NOT NULL;

  SELECT count(*) INTO v_unmatched
    FROM probe_observations o JOIN scan_jobs j ON j.id = o.job_id
   WHERE j.brand_key = p_brand AND o.purpose = 'scan'
     AND o.state IN ('answered','valid_no_aio','failed','ambiguous','blocked')
     AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.observation_id = o.id)
     AND NOT EXISTS (SELECT 1 FROM workspace_questions q WHERE q.brand_key = p_brand
                       AND q.text_normalized = normalize_question_text(o.query));
  RETURN jsonb_build_object('scan', v_scan, 'explore', v_explore, 'legacy', v_legacy,
                            'imported', v_imported, 'unmatched', v_unmatched);
END $$;

CREATE OR REPLACE FUNCTION public.prune_question_answer_links(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM question_answer_links WHERE collected_at < p_before ORDER BY collected_at LIMIT p_limit)
  DELETE FROM question_answer_links l USING old WHERE l.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.link_question_answers(text,integer,boolean,text),
  public.prune_question_answer_links(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_question_answers(text,integer,boolean,text),
  public.prune_question_answer_links(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

Notes:
- Only rows that already match a question are candidates, so unmatched history never starves the limit; `unmatched` reports how many scan answers have no question yet.
- `explore_run_id`, `source = 'explore'` rows exist only when F11 is merged; the statement is valid without F11 because `purpose = 'explore'` rows simply do not exist (the CHECK in 027 rejects them until F11's 090).
- **Backfill of existing observations** (phase 1 rollout): the owner runs, once per workspace, `select brand_key, link_question_answers(brand_key, 100000, true, 'backfill') from customer_brands where is_active;`. `p_import_missing = true` creates archived `import` questions for historical texts that F08's own panel import did not create, so every past answer is reachable from some question. The periodic job keeps linking afterwards without importing.
- `scripts/setup-supabase.mjs` registers the table and both functions; the CI tenant RLS test adds `question_answer_links`.

### 6.2 Server modules

All under `src/lib/questions/history/` (TypeScript, relative imports with extensions), shared types in `src/shared/question-history.ts`.

#### `src/shared/question-history.ts` (PORT of `PromptDateRange.tsx:11-60`, `ai-visibility.ts` answer types)

```ts
export const HISTORY_RANGES = ["last_7_days", "last_28_days", "last_90_days", "all", "custom"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const HISTORY_RANGE_LABELS: Record<HistoryRange, string> = { last_7_days: "Last 7 days", last_28_days: "Last 28 days",
  last_90_days: "Last 90 days", all: "All available history", custom: "Custom range" };
export type HistoryPeriod = { preset: HistoryRange; start: string; end: string };      // local YYYY-MM-DD
export function historyPeriod(preset?: HistoryRange, now?: Date): HistoryPeriod;        // default last_28_days
export function periodToQuery(p: HistoryPeriod): { from?: string; to?: string } | null; // ISO instants of local day bounds; null when custom is invalid; {} for "all"
export const HISTORY_MAX_EXECUTIONS = 500;
export const ANSWER_DISPLAY_LIMIT = 24_000;
export const executionSchema = z.looseObject({
  answerId: z.uuid(), source: z.enum(["scan","explore","legacy"]), engine: z.string(), engineLabel: z.string(),
  collectedAt: z.iso.datetime(), trigger: z.enum(["manual","scheduled","explore","legacy"]),
  status: z.enum(["answered","no_answer","failed","blocked","unknown"]),
  ownMentioned: z.boolean().nullable(), ownCited: z.boolean().nullable(),
  askedText: z.string(), scanId: z.uuid().nullable(), exploreRunId: z.uuid().nullable(),
  method: z.enum(["consumer_capture","model_api","google_serp","unknown"]), quality: z.enum(["measured","legacy_unknown"]) });
export const brandSummarySchema = z.looseObject({ name: z.string(), isSelf: z.boolean(), answers: z.int().min(0),
  mentions: z.int().min(0), unknown: z.int().min(0), citations: z.int().min(0) });
export const answerDetailSchema = z.looseObject({ … });   // §6.5
export function excerpt(text: string, span: { start: number; end: number }, radius = 70): { before: string; match: string; after: string };
```

#### `src/lib/questions/history/links.ts`

`linkQuestionAnswers(admin, brandKey, { limit, importMissing, linkedBy }) → { scan, explore, legacy, imported, unmatched }` (RPC). `linkBeforeRead(admin, brandKey)` = `linkQuestionAnswers(..., { limit: 500, linkedBy: "read" })` wrapped so any error logs `[question-history] lazy link failed {brandKey}` and returns `null`.

#### `src/lib/questions/history/history.ts`

```ts
export async function getQuestionHistory(ws: Workspace, questionId: string,
  q: { from?: string; to?: string; engines?: string[] }, deps?: HistoryDeps): Promise<QuestionHistory>;
```
1. `linkBeforeRead(admin, brandKey)`.
2. Question: `workspace_questions` by `id` and `brand_key` → else `AppError(404,"question_not_found","This question does not exist in this workspace.")`. Also `replacedBy` (its `replaced_by`) with that question's text, and `replaces` = questions whose `replaced_by = id` (id, text).
3. Links: `question_answer_links` where `question_id`, `brand_key`, `collected_at` within range, `engine IN engines` when given, ordered `collected_at desc`, limit 501 → `truncated = rows > 500`.
4. Execution facts, batched 100 ids per request (as `measurement/route.js:38-44`), projecting JSON paths only, never `text`:
   - observations: `id, purpose, state, reason, observed_at, total_cost, answer_present:result->>answer_present, aio_present:result->>aio_present, serp_state:result->>serp_state, error:result->>error, mention_state:result->entity_evidence->>mention_state, own_mentioned:result->>brand_mentioned_in_text, own_cited:result->>brand_cited, brands:result->brands, competitors_cited:result->competitors_cited, method:result->>measurement_method, is_branded:result->>is_branded_query`, with `brands` mapped to `{ name, is_self, mentioned }` only.
   - legacy `prompt_results`: `id, answered, mentioned, brand_cited, raw->>error, raw->brands, raw->competitors_cited, raw->>measurement_method`.
   - scheduled: `measurement_windows.job_id IN (scan_job_ids)` → `trigger: "scheduled"`, else `"manual"`; explore → `"explore"`; legacy → `"legacy"`.
5. `status`: `answered` when answer present and no error; `no_answer` for `valid_no_aio` or an answered-false legacy row; `failed` for `failed` or an error; `blocked`; `unknown` for `ambiguous`.
6. `summary = summarizeBrands(rows.filter(r => r.source !== "explore"))`; `coverage = { total, answered, noAnswer, failed, explore, legacy }`.
7. Telemetry `question_history:viewed { executions: n, range: preset }` (no text).

#### `src/lib/questions/history/summary.ts` (PORT of `ai-visibility-results.ts:8-44`)

```ts
export function summarizeBrands(rows: ExecutionFacts[]): BrandSummary[];
```
For each row with `status === "answered"`: roster = `brands[]` (self + rivals tracked at that scan); if `brands` is empty, roster = self only from `own_mentioned`. Per brand (keyed by lower-cased name; self keyed as `self`): `mentioned === null` (or self `mention_state !== "observed"`) → `unknown++`; else `answers++` and `mentions += mentioned ? 1 : 0`; citations: self `own_cited === true`; rival `competitors_cited` contains its name (case-insensitive). Order: self first, then by mentions desc, citations desc, name asc (OpenSEO `PromptSummary.tsx:22-29`). The workspace display name labels the self row.

#### `src/lib/questions/history/answer.ts`

```ts
export async function getQuestionAnswer(ws: Workspace, questionId: string, answerId: string, deps?): Promise<AnswerDetail>;
```
1. Link by `id`, `question_id`, `brand_key` → else `AppError(404,"answer_not_found","This answer does not exist in this workspace.")`.
2. Observation (`result`, `state`, `reason`, `result->>attempt_id`) or legacy row (`answer_text`, `raw`).
3. `text` = `result.text` (plain; spans index into it); `markdown` = `result.answer_markdown ?? null` (F02); display source = `markdown ?? text`, cut to 24,000 (`truncated`). Legacy: `text = answer_text`, `markdown = null`.
4. Citations from `result.references` in order: `safeHttpUrl` (F02 `src/shared/safe-url.ts`), `domain` = hostname without `www.`, `title`, `position` (1-based), `owned` = domain matches the workspace website host (`customer_brands.website_host`, subdomains included), `competitor` = name from `competitors_cited` whose alias matches the domain (`getBrandAliases(name,"")`, same rule as `findCompetitorsCited`, `enginePipeline.js:442-466`), else `null`. Unsafe URLs are dropped.
5. Brands: self from `entity_evidence` (`mentioned`, `spans`) and `brand_cited`; rivals from `brands[]` (`mentioned`, `position`, `relationship`, `sentiment_label`, `spans`). Spans normalised to `{ start, end }`, kept only when `0 ≤ start < end ≤ text.length`, de-duplicated, sorted. No matcher runs on read: these are the spans recorded when the answer was judged, so later alias edits do not rewrite history (OpenSEO §2 fact 14; Perceev keeps the stronger alias matcher).
6. Evidence: captures from `measurement_evidence` for `(observation_id, attempt_token = result.attempt_id)`, mapped exactly as `measurement/route.js:46-47`, `:54`: `withdrawn` when `reason = 'redaction_retracted'`; `expired` when stored and `expires_at` passed; `stored`; otherwise `incomplete`. `href = /api/customer/measurement/evidence?brand_key={k}&observation={id}&attempt={token}&index={i}` only for `stored`. Legacy rows: `{ state: "legacy_unknown", captures: [] }`.
7. Provenance: `method` (`consumer_capture` → "Consumer app", `model_api` → "Model API", `google_serp` → "Google search"), `gateway`, `requestedModel`, `returnedModel`, `requestedLocation`, `searchUsed` (`provenance.search_state`).
8. `error`: a public message: `failed` → "Collection failed. This answer was not measured."; `blocked` → "Collection was not attempted (blocked before a request)."; `ambiguous` → "The result of this request is unknown; it may have been charged and will be reconciled."; never the provider's raw message.

#### `src/app/api/customer/measurement/evidence/route.js` (existing, extended)

Ownership query becomes two reads: first the existing `scan_jobs!inner(brand_key)` select; if not found, `probe_observations` where `id = observation AND purpose = 'explore' AND brand_key = ctx.brand.brandKey`. Everything after ownership is unchanged (same statuses and copy).

#### `src/app/api/customer/scan/report/[scan_id]/route.js` (existing, extended)

Adds `questionIdByQuery: Record<string, string>`: rows of `question_answer_links` where `scan_id = scanId` and `brand_key` = the scan's workspace (`select asked_text, question_id`), keyed by `asked_text.trim().toLowerCase()` (the same key `groupQuestions` uses, `reportData.js:180-202`). This is a display-lookup key only, matching the existing client grouping; question identity in the database always uses F08's `normalize_question_text`. Planned questions with no linked answer get no entry and therefore no link. The field is additive; nothing else in the response changes.

#### Jobs and registrations

- `src/lib/questions/history/jobs.ts` (imported from `src/lib/jobs/kinds.ts`): `definePeriodic({ name: "questions.link", everySeconds: 300, run })` → `enqueueSystemJob("questions.link", {}, { dedupeKey: "questions.link:" + slot5m })`; the job lists active brands (`customer_brands.is_active`, ordered, at most 200) and runs `step.do("link-" + n, DB_STEP, () => linkQuestionAnswers(admin, brand, { limit: 2000, linkedBy: "periodic" }))` for n = 1…count. `definePeriodic({ name: "questions.links.retention", everySeconds: 86400, run })` → `prune_question_answer_links(now − 395 days, 5000)` looped up to 20 times.
- Event names use F26's `area:action` form. F26 adds the calls directly (F26 §6.2.7, no sink module).
- `src/lib/telemetry/events.ts` (F26): `question_history:viewed { executions, range }`, `question_history:answer_opened { engine, source }`.
- `src/lib/query/keys.ts`: `questionHistoryKeys = { history: (brandKey, questionId, from, to) => ["question-history", brandKey, questionId, from ?? "", to ?? ""], answer: (brandKey, questionId, answerId) => ["question-history", brandKey, questionId, "answer", answerId] }`.

### 6.3 Jobs

| Kind | Trigger | Steps | Retries / billed | Completion |
|---|---|---|---|---|
| `questions.link` | periodic 300 s (system) | `link-1` … `link-N` (one per active workspace, max 200) | DB_STEP (3 retries), not billed | `completed` `{ linked }`; a failing step fails the job; the next slot runs anyway |
| `questions.links.retention` | periodic daily (system) | `prune-1` … `prune-20` | DB_STEP | `completed` |

### 6.4 Provider calls and cost

None. F12 reads stored data only. Evidence links are signed by the existing route (120 s maximum).

### 6.5 API routes

All routes: `requireWorkspace` (F01), `toErrorResponse`, `Cache-Control: no-store`; contracts in `src/lib/questions/history/history.contract.ts`. Paths are under `[questionId]/history` and `[questionId]/answers` so they cannot collide with F08's question CRUD routes.

**`GET /api/customer/questions/[questionId]/history`** (file `src/app/api/customer/questions/[questionId]/history/route.ts`)

```ts
const params = z.strictObject({ questionId: z.uuid() });
const query = z.strictObject({ brand_key: z.string().min(1).max(200).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  engines: z.string().regex(/^[a-z_]+(,[a-z_]+)*$/).max(100).optional() });
const response = z.looseObject({
  question: z.looseObject({ id: z.uuid(), text: z.string(), topic: z.string().nullable(), status: z.string(), branded: z.boolean(),
    origin: z.string(), replacedBy: z.looseObject({ id: z.uuid(), text: z.string() }).nullable(),
    replaces: z.array(z.looseObject({ id: z.uuid(), text: z.string() })) }),
  range: z.looseObject({ from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable() }),
  executions: z.array(executionSchema), summary: z.array(brandSummarySchema),
  coverage: z.looseObject({ total: z.int(), answered: z.int(), noAnswer: z.int(), failed: z.int(), explore: z.int(), legacy: z.int() }),
  truncated: z.boolean(), latestScanId: z.uuid().nullable() });
```

200 example:

```json
{ "question": { "id": "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182", "text": "best oversized t-shirt brands in india",
    "topic": "Oversized tees", "status": "active", "branded": false, "origin": "ai_setup", "replacedBy": null, "replaces": [] },
  "range": { "from": "2026-09-23T18:30:00.000Z", "to": "2026-10-21T18:29:59.999Z" },
  "executions": [
    { "answerId": "6a1f…", "source": "scan", "engine": "chatgpt", "engineLabel": "ChatGPT", "collectedAt": "2026-10-20T10:12:04.000Z",
      "trigger": "manual", "status": "answered", "ownMentioned": false, "ownCited": false, "askedText": "best oversized t-shirt brands in india",
      "scanId": "9e8d…", "exploreRunId": null, "method": "model_api", "quality": "measured" },
    { "answerId": "7b2e…", "source": "scan", "engine": "aio", "engineLabel": "Google AI Overviews", "collectedAt": "2026-10-20T10:14:41.000Z",
      "trigger": "manual", "status": "no_answer", "ownMentioned": null, "ownCited": null, "askedText": "best oversized t-shirt brands in india",
      "scanId": "9e8d…", "exploreRunId": null, "method": "google_serp", "quality": "measured" } ],
  "summary": [ { "name": "Offcult", "isSelf": true, "answers": 3, "mentions": 0, "unknown": 0, "citations": 0 },
               { "name": "Bewakoof", "isSelf": false, "answers": 3, "mentions": 2, "unknown": 0, "citations": 1 } ],
  "coverage": { "total": 4, "answered": 3, "noAnswer": 1, "failed": 0, "explore": 0, "legacy": 0 },
  "truncated": false, "latestScanId": "9e8d…" }
```

Errors: 400 `invalid_request` (bad uuid, bad dates, `from > to` → `invalid_range` "Choose a start date on or before the end date."); 401/403/404/503 from `requireWorkspace`; 404 `question_not_found`; 503 `history_unavailable` "Question history could not be loaded. Please retry." on a database error. Read-only and idempotent.

**`GET /api/customer/questions/[questionId]/answers/[answerId]`** (file `src/app/api/customer/questions/[questionId]/answers/[answerId]/route.ts`)

```ts
const params = z.strictObject({ questionId: z.uuid(), answerId: z.uuid() });
const query = z.strictObject({ brand_key: z.string().min(1).max(200).optional() });
const response = z.looseObject({
  execution: executionSchema, text: z.string().nullable(), markdown: z.string().nullable(), truncated: z.boolean(),
  citations: z.array(z.looseObject({ url: z.string(), domain: z.string(), title: z.string().nullable(), position: z.int().min(1),
    owned: z.boolean(), competitor: z.string().nullable() })),
  brands: z.array(z.looseObject({ name: z.string(), isSelf: z.boolean(), mentioned: z.boolean().nullable(),
    cited: z.boolean().nullable(), position: z.int().nullable(), relationship: z.string().nullable(),
    sentimentLabel: z.string().nullable(), spans: z.array(z.looseObject({ start: z.int().min(0), end: z.int().min(1) })) })),
  provenance: z.looseObject({ method: z.string(), methodLabel: z.string(), gateway: z.string().nullable(),
    requestedModel: z.string().nullable(), returnedModel: z.string().nullable(), requestedLocation: z.string().nullable(),
    searchUsed: z.enum(["observed_used","observed_not_used","unknown"]) }),
  evidence: z.looseObject({ state: z.enum(["stored","expired","withdrawn","incomplete","legacy_unknown","none"]),
    captures: z.array(z.looseObject({ index: z.int().min(0), state: z.string(), href: z.string().nullable(), expiresAt: z.iso.datetime().nullable() })) }),
  error: z.string().nullable() });
```

200 example (abridged text):

```json
{ "execution": { "answerId": "6a1f…", "source": "scan", "engine": "chatgpt", "engineLabel": "ChatGPT", "collectedAt": "2026-10-20T10:12:04.000Z",
    "trigger": "manual", "status": "answered", "ownMentioned": false, "ownCited": false, "askedText": "best oversized t-shirt brands in india",
    "scanId": "9e8d…", "exploreRunId": null, "method": "model_api", "quality": "measured" },
  "text": "Popular oversized t-shirt brands in India include Bewakoof and The Souled Store …",
  "markdown": "Popular **oversized** t-shirt brands in India include **Bewakoof** and **The Souled Store** …",
  "truncated": false,
  "citations": [ { "url": "https://www.bewakoof.com/oversized", "domain": "bewakoof.com", "title": "Oversized T-shirts", "position": 1, "owned": false, "competitor": "Bewakoof" } ],
  "brands": [ { "name": "Offcult", "isSelf": true, "mentioned": false, "cited": false, "position": null, "relationship": null, "sentimentLabel": null, "spans": [] },
              { "name": "Bewakoof", "isSelf": false, "mentioned": true, "cited": true, "position": 1, "relationship": "recommended", "sentimentLabel": "positive", "spans": [ { "start": 49, "end": 57 } ] } ],
  "provenance": { "method": "model_api", "methodLabel": "Model API", "gateway": "openrouter", "requestedModel": "openai/gpt-6-luna",
    "returnedModel": "openai/gpt-6-luna", "requestedLocation": "in", "searchUsed": "observed_used" },
  "evidence": { "state": "stored", "captures": [ { "index": 0, "state": "stored", "href": "/api/customer/measurement/evidence?brand_key=offcult&observation=3f1e…&attempt=a1b2…&index=0", "expiresAt": "2027-01-18T10:12:04.000Z" } ] },
  "error": null }
```

Errors: 400 `invalid_request`; workspace errors; 404 `answer_not_found`; 503 `history_unavailable`.

**`GET /api/customer/measurement/evidence`** (existing): unchanged contract; ownership now also accepts the workspace's explore observations (§6.2).

**`GET /api/customer/scan/report/[scan_id]`** (existing): adds `questionIdByQuery` (object, may be empty).

### 6.6 UI

Route `src/app/portal/questions/[questionId]/page.tsx` (client component in the F04 shell; not in the sidebar, conventions §12). Components under `src/components/portal/questions/history/`: `QuestionHistoryPage.tsx` (PORT `PromptHistoryPage.tsx`), `HistoryDateRange.tsx` (PORT `PromptDateRange.tsx`), `BrandComparison.tsx` (PORT `PromptSummary.tsx`), `AnswerPanel.tsx` (PORT `PromptAnswers.tsx` + `ExecutionSelects` from `PromptAnalysis.tsx:124-198`), `AnswerEvidence.tsx` (PORT `AnswerContent.tsx`), `Executions.tsx` (PORT `PromptExecutions.tsx`), `MentionBadge.tsx` (PORT `AiMatchBadge`, `shared.tsx:184-196`), `QuestionHistoryLink.tsx`, `hooks/useQuestionHistory.ts`. Shared: `src/components/app/markdown/MarkdownAnswer.tsx` from F11 (F12 adds it if F11 has not merged: same COPY of OpenSEO's `MarkdownAnswer.tsx`; the answer view uses the non-collapsing variant `collapse={false}`). Primitives (F04): `PageHeader`, `BackLink`, `Card`, `Table`, `Badge`, `Button`, `Select`, `Input`, `Tabs`, `Accordion`, `Alert`, `Skeleton`, `EmptyState`, `Tooltip`.

**URL state:** `/portal/questions/{id}?range=last_28_days|last_7_days|last_90_days|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&engine=<engine>&answer=<answerId>&from_scan=<scanId>`. Defaults: `range=last_28_days`, no engine filter, `answer` = newest answered execution in range, else newest. Changes use `router.replace` (no history spam) except `answer`, which uses `push` so back returns to the previous answer. Invalid parameters fall back to defaults silently.

**Header:**
- Back link: when `from_scan` is present → "Back to scan report" (`/portal/scans/{from_scan}`); else "All questions" (`/portal/measurement`).
- Title: `question.text` (`whitespace-pre-wrap`, `data-ph-mask`).
- Description: "{topic} · Question history" (topic missing → "Question history").
- Badges: status "Active" (success) / "Paused" (secondary) / "Archived" (secondary); "Branded" (outline) when `branded`, tooltip "Branded questions are diagnostics and are not counted in visibility."
- Action: "View latest scan" (outline) → `/portal/scans/{latestScanId}` when present.
- Notices (`Alert` info): `replaces[0]` → "This question replaced an earlier wording: “{text}”. View its history" (link); `replacedBy` → "A newer wording replaced this question: “{text}”. View its history" (link).

**Body order:** date range control → Brand comparison → Answer → Executions → footnotes.

**Date range control:** `Select` (aria-label "Analysis date range", calendar icon) with the five labels; "Custom range" shows two date inputs (aria-labels "Period start date", "Period end date") joined by "to"; invalid → inline `role="alert"` "Choose a start date on or before the end date." and no request is made.

**Brand comparison (card titled "Brand comparison"):** `Table` columns "Brand", "Mentioned", "Cited". Self row first with "You" badge. Cells: rate `aiRate(mentions, answers)` ("—" when 0 answers) with muted sub-line "{mentions} of {answers}" and, when `unknown > 0`, "({unknown} unknown)"; `title` attribute "{x} of {y} answers". First 4 rows, then "Show {n} more". Empty: "No brand evidence is available for this period yet." Footnote under the card (muted, xs): "Rates count scan answers only. Prompt Explorer answers are listed below but not counted. Answers where a mention could not be confirmed are shown as unknown and left out of the rate."

**Answer section (card titled "Answer"):** right-aligned controls: `Select` aria-label "Engine" (engines present in range, labels from `engineLabel`, `reportData.js:61-66`) and `Select` aria-label "Answer date" (that engine's executions: local date-time, plus " · {status label}" when not answered, plus " · Explorer" for explore). Switching engine keeps the same scan when that engine answered it, else the newest answered, else the newest (OpenSEO rule).
- "Collected question: {askedText}" (muted, `data-ph-mask`) when `askedText` differs from `question.text`.
- Provenance line (muted, xs): "{methodLabel} · via {Gateway} · {returnedModel ?? requestedModel ?? 'model not reported'} · requested location {LOCATION}" and, for `quality = legacy_unknown`, "Collected before measurement records; quality unknown."
- Loading answer: `Skeleton` block 6 lines, `aria-busy`.
- Load error: `Alert` destructive "This answer could not be loaded." + "Retry".
- Status notes (top of the answer, warning tone): AIO `no_answer` → "Google showed no AI Overview for this search. This collection is excluded from visibility rates."; other `no_answer` → "No substantive answer was returned. This collection is excluded from visibility rates."; `failed`/`blocked`/`unknown` → `error` text + "This collection is excluded from visibility rates."; `truncated` → "This response was truncated. The retained evidence may be incomplete."
- Layout ≥ 1024 px: grid `minmax(0,1fr) 300px`; left `article` (aria-label "AI answer", `data-ph-mask`) renders `markdown ?? text` through `MarkdownAnswer` (images → "[Image: {alt}]"); no answer → "No answer was captured. Status: {status}. This is not a negative brand result." Right `aside` (aria-label "Answer evidence") with `Tabs`: "Citations ({n})" and "Brands".
- < 1024 px: a button group "Answer" / "Citations ({n})" / "Brands" (`aria-pressed`) switches the single visible panel.
- **Citations tab:** "This answer has no citations." when empty; else a card per citation: globe icon + domain (no third-party favicon fetch), link text = title or URL (`target="_blank" rel="noreferrer"`, http/https only), badges "Your site" when `owned`, "Competitor: {name}" when `competitor`.
- **Brands tab:** help "Mentions appear in the answer text. Citations link to the brand’s domain."; empty "No brand evidence was captured."; per brand: name, "You" badge for self; when the execution is answered: `MentionBadge` ("Mentioned"/"Not mentioned"/"Unknown") and cited badge ("Cited"/"Not cited"; rivals without data show nothing); "Position #{n}" badge when `position`; sentiment/relationship badge when present (`sentimentLabel` capitalised); `Accordion` "Mention excerpts ({n})" listing `excerpt(text, span)` as “{before}<mark>{match}</mark>{after}” (`data-ph-mask`).
- **Evidence footer** (muted, xs): `stored` → "Raw capture: Open" (link to `href`, new tab) + " · expires {date}"; `expired` → badge "Expired" + "Raw capture expired under the retention policy. The measurement is retained."; `withdrawn` → badge "Withdrawn" + "This capture was withdrawn because its redaction could not be verified. The measurement is retained."; `incomplete` → "Raw capture was not stored for this answer."; `legacy_unknown`/`none` → nothing. A 410 from the evidence link is shown as a toast with the response text.

**Executions (card titled "Executions", header right "{n} in this period"):** column header (≥ 640 px) "Date", "Engine", "Brand mentioned", "Owned citation"; each row a button (`aria-pressed` when selected): local date-time plus a small tag "Scheduled" / "Explorer" / "Legacy" (none for manual scans); engine label; answered rows show two `MentionBadge`s (mentioned; cited with positive label "Cited"); other rows one badge spanning both columns: "No AI Overview shown" (AIO no answer), "No substantive answer", "Collection failed" (destructive), "Not attempted", "Result unknown". List max height 16 rem (11 rem ≥ 640 px), scrolls.

**Empty and edge states:**

| State | Content |
|---|---|
| Loading (first) | header skeleton; three `Skeleton` cards (table 4 rows, answer block, list 5 rows) |
| History error | `Alert` destructive "Question history could not be loaded." + "Retry"; stale data stays visible on refetch failures |
| Not found (404) | `EmptyState` "Question not found" / "This question does not exist, or it belongs to a workspace you cannot open." + button "All questions" |
| No answers at all | `EmptyState` "No answers yet" / "This question is asked in your next scan after it is in an approved panel." + "Go to Questions" (`/portal/measurement`) |
| No answers in range | `EmptyState` "No answers in this period" / "Choose another date range to see this question’s answers." + "Show all available history" (sets `range=all`) |
| Engine filter empty | Answer card shows "No answers from {Engine} in this period." |
| Truncated | footnote "History shows the latest 500 answers. Older answers are not included in this period’s numbers." |

**Linking into the page:**
- `QuestionHistoryLink` (`{ questionId, fromScan? }`): ghost small button, icon `History`, text "History", `aria-label="Question history"`.
- Scan report: `src/components/portal/scans/ReportCards.jsx` `QuestionRow` renders `QuestionHistoryLink` in the expanded answers area, first line, when `questionIdByQuery[question.query.toLowerCase()]` exists; `QuestionsCard` receives `questionIdByQuery` and `scanId` from `src/app/portal/scans/[scanId]/page.jsx`.
- Questions page: F08's question row (F08 §6.6) renders `QuestionHistoryLink` in its actions cell (requested from F08; if F08 merges first, F12's phase 3 PR adds the one element to F08's row component).

**Data fetching:** `useQuery` history (`staleTime: 60_000`, `retry: 1`, `placeholderData: keepPreviousData` so the old range stays visible while the new one loads); answer detail `useQuery` keyed by answer id (`staleTime: 300_000`). No polling.

**Accessibility:** headings per card; selects labelled; tabs and toggle buttons keyboard-operable; excerpts use `<mark>`; badges carry text; external links have visually hidden "(opens in a new tab)".

**Phone (< 640 px):** date controls stack; brand table scrolls horizontally inside its card only; answer shows the button group; executions render two-column rows (date + engine over badges); no page-level horizontal scroll.

### 6.7 Permissions, privacy, observability

- Members and owners of the workspace can read; nothing is writable from the page.
- `question_answer_links` has a tenant read policy; answer text is read only through service-role routes after `requireWorkspace` and filtered by `brand_key`. P0 tables stay service-only.
- Evidence: links go through the existing signed-URL route (≤ 120 s, `Referrer-Policy: no-referrer`); withdrawn and expired captures never get a link; withdrawal keeps the measurement and the answer text (P0 privacy withdrawal removes only raw objects).
- Never logged: question text, answer text, excerpts, citation URLs. Allowed lines: `[question-history] lazy link failed {brandKey}`, `[question-history] read failed {code}`.
- Telemetry (F26): `question_history:viewed { executions, range }`, `question_history:answer_opened { engine, source }`. `data-ph-mask` on title, collected question, answer and excerpts.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/routes/_app/p/$projectId/ai-visibility/prompts/$promptId.tsx` | `src/app/portal/questions/[questionId]/page.tsx` | PATTERN | Next.js page; key by workspace + question. |
| `openseo:src/client/features/ai-visibility/PromptHistoryPage.tsx` | `src/components/portal/questions/history/QuestionHistoryPage.tsx` | PORT | No "Run now"; adds status/branded badges, wording notices, "View latest scan". |
| `openseo:src/client/features/ai-visibility/PromptAnalysis.tsx` | `QuestionHistoryPage.tsx`, `AnswerPanel.tsx` | PORT | Range filtering moves to the server (`from`/`to`); selection rules and `ExecutionSelects` kept; URL state added. |
| `openseo:src/client/features/ai-visibility/PromptDateRange.tsx` | `src/shared/question-history.ts`, `HistoryDateRange.tsx` | PORT | `enum` → string union (erasable TS); same presets, default and copy. |
| `openseo:src/client/features/ai-visibility/PromptSummary.tsx` | `BrandComparison.tsx` | PORT | Unknown counts; brand keyed by name (we track names and aliases, not domains); no favicon fetch. |
| `openseo:src/shared/ai-visibility-results.ts:8-44` | `src/lib/questions/history/summary.ts` | PORT | Unknown mention states excluded from the denominator; rival citation from `competitors_cited`; explore excluded. |
| `openseo:src/client/features/ai-visibility/PromptAnswers.tsx` | `AnswerPanel.tsx` | PORT | Copy kept; provenance line added. |
| `openseo:src/client/features/ai-visibility/AnswerContent.tsx` | `AnswerEvidence.tsx` | PORT | Stored spans instead of read-time matching; evidence footer (stored/expired/withdrawn); owned/competitor citation badges; relationship/sentiment badges. |
| `openseo:src/client/features/ai-visibility/PromptExecutions.tsx` | `Executions.tsx` | PORT | Triggers Scheduled/Explorer/Legacy; more statuses. |
| `openseo:src/client/features/ai-visibility/shared.tsx:97-109, 184-206` | `hooks/useQuestionHistory.ts`, `MentionBadge.tsx`, `src/shared/question-history.ts` | PORT | `aiRate`, `aiDate`, `AiMatchBadge` (adds "Unknown"). |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityResults.ts:56-89, 205-288` | `src/lib/questions/history/history.ts`, `answer.ts` | PORT | Rows from our observations/prompt_results via links; 50 runs → 500 answers; 24,000-char display limit kept. |
| `openseo:src/server/features/ai-visibility/services/aiVisibilityMatching.ts:12-63` | (not used on read) | PATTERN | We keep the spans recorded at judging time (`entityEvidence.js`, `judge.js`), matching OpenSEO's brand-snapshot principle. |
| `openseo:src/client/features/ai-search/components/MarkdownAnswer.tsx` | `src/components/app/markdown/MarkdownAnswer.tsx` (F11) | COPY | Shared with F11; `collapse={false}` here. |

## 8. Implementation plan

### Phase 1 — Links and backfill (requires F08 merged)

**Goal:** every collected answer of a workspace is linked to a stable question id.

- [ ] **P1.T1 Migration**
  - [x] **P1.T1.S1** *Files:* `supabase/migrations/095_f12_question_answer_links.sql` (§6.1), `scripts/setup-supabase.mjs` (required objects), `.github/workflows/ci.yml` (tenant RLS list adds `question_answer_links`). *Verify:* CI `customer-database` applies all migrations (the F08 guard passes because F08's migrations 075–079 precede 095).
- [ ] **P1.T2 DB tests**
  - [x] **P1.T2.S1** *Files:* `scripts/qa/check-f12-db.mjs` (loopback `_qa` DB, pattern `scripts/qa/check-repair-workflows.mjs:13-18`). Fixture: two workspaces; workspace A has questions Q1 (text "Best oversized tees in India"), Q2; scan 1 (panel v1 without question ids) and scan 2 (panel v2 with `question_id` = Q1 for text "best  oversized tees in india"); observations in states answered, valid_no_aio, failed, leased, posted; matching `prompt_results`; two legacy `prompt_results` without observations; one historical text with no question; workspace B with the same text. Groups: `links-rls` (AC-01), `link-scan` (AC-02: both scans link to Q1, non-terminal rows skipped, `prompt_result_id` filled, second call inserts 0), `link-explore-legacy` (AC-03; explore rows inserted only when F11's 090 is applied, else the group asserts zero explore links), `link-import` (AC-04), `links-retention` (AC-12). *Verify:* `node scripts/qa/check-f12-db.mjs` → "ok 5 groups".
- [ ] **P1.T3 Linking code and jobs**
  - [x] **P1.T3.S1** *Files:* `src/lib/questions/history/links.ts`, `links.test.ts` (RPC args, lazy-link error swallowed and logged without text). *Verify:* `node --test src/lib/questions/history/links.test.ts` → pass (F12-AC-05 unit half).
  - [x] **P1.T3.S2** *Files:* `src/lib/questions/history/jobs.ts`, `src/lib/jobs/kinds.ts` (one import line). *Verify:* `node --test src/lib/jobs/*.test.ts` → pass; `node scripts/qa/check-f12-db.mjs --group link-scan` → ok.
  - [x] **P1.T3.S3** *Files:* `docs/runbooks/question-history-backfill.md` (the one-time owner SQL in §6.1, how to read `unmatched`, how to re-run). *Verify:* doc-status header present (`node --test src/lib/docStatus.test.mjs` → pass).

**Checkpoint:** CI database job, `check-f12-db.mjs`, full suite, build green. Completes F12-AC-01…05, 12.

### Phase 2 — Read API

**Goal:** the history and answer routes return everything the page needs.

- [x] **P2.T1 Shared and summary**
  - [x] **P2.T1.S1** *Files:* `src/shared/question-history.ts`, `src/shared/question-history.test.ts` (presets, local-day bounds across a DST-free and a UTC+5:30 zone, invalid custom → null, `excerpt` at text edges and with surrogate pairs). *Verify:* `node --test src/shared/question-history.test.ts` → pass.
  - [x] **P2.T1.S2** *Files:* `src/lib/questions/history/summary.ts`, `summary.test.ts` (OpenSEO parity fixture translated to our rows: same numbers; unknown excluded; explore excluded; rival citations; ordering). *Verify:* pass (F12-AC-07).
- [x] **P2.T2 Services and routes**
  - [x] **P2.T2.S1** *Files:* `src/lib/questions/history/history.ts`, `answer.ts`, `history.test.ts`, `answer.test.ts` (memory admin client), fixtures `tests/fixtures/f12/{observations.json,prompt-results.json,evidence.json}` (synthetic text; spans valid and out-of-range; a withdrawn and an expired capture; unsafe citation URL). *Verify:* `node --test src/lib/questions/history/*.test.ts` → pass (F12-AC-08 unit half, 13, 14).
  - [x] **P2.T2.S2** *Files:* `src/app/api/customer/questions/[questionId]/history/route.ts`, `src/app/api/customer/questions/[questionId]/answers/[answerId]/route.ts`, `src/lib/questions/history/history.contract.ts`, `src/lib/questions/history/history.route.test.mjs` (hook pattern `src/lib/customerRoutes.test.hooks.mjs`). Cases: 404 other workspace and unknown ids; range filter; `from > to` → 400 `invalid_range`; 500 cap with `truncated`; response JSON contains no `text` key in history; answer 404 cross-workspace; evidence `href` only for stored. *Verify:* `node --test src/lib/questions/history/history.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F12-AC-06, 08).
  - [x] **P2.T2.S3** *Files:* `src/app/api/customer/measurement/evidence/route.js`, `src/lib/questions/history/evidenceRoute.route.test.mjs` (scan observation unchanged: 404/409/410 copy byte-identical; explore observation of own workspace → 302; other workspace → 404). *Verify:* pass (F12-AC-09).
  - [x] **P2.T2.S4** *Files:* `src/app/api/customer/scan/report/[scan_id]/route.js` (`questionIdByQuery`), `src/lib/questions/history/reportLinks.route.test.mjs`. *Verify:* pass; `node --test src/components/portal/portalRegressions.test.mjs` → pass.
  - [x] **P2.T2.S5** *Files:* `src/lib/telemetry/events.ts`, `src/lib/query/keys.ts`. *Verify:* `npm run typecheck` → exit 0.

**Checkpoint:** full suite, typecheck, build, contract test. Completes F12-AC-06…09, 13, 14 (API half).

### Phase 3 — Page and links (requires F04, F05 merged; F11's `MarkdownAnswer` or its copy)

**Goal:** customers open a question and read its history.

- [x] **P3.T1 Page**
  - [x] **P3.T1.S1** *Files:* `src/components/app/markdown/MarkdownAnswer.tsx` (only if F11 has not added it), `src/components/portal/questions/history/*` (§6.6), `src/app/portal/questions/[questionId]/page.tsx`. *Verify:* `npm run build` → exit 0.
- [x] **P3.T2 Entry points**
  - [x] **P3.T2.S1** *Files:* (`QuestionHistoryLink.tsx` already exists from F08; import it, do not recreate it) `src/components/portal/scans/ReportCards.jsx` (`QuestionsCard` and `QuestionRow` take `questionIdByQuery`, `scanId`), `src/app/portal/scans/[scanId]/page.jsx` (passes them), `src/components/portal/scans/reportHistoryLinks.test.mjs` (render harness `src/lib/renderHarness.mjs`: link present only for linked questions, href includes `from_scan`). *Verify:* `node --test src/components/portal/scans/reportHistoryLinks.test.mjs src/components/portal/portalRegressions.test.mjs` → pass (F12-AC-11).
  - [x] **P3.T2.S2** *Files:* `src/components/portal/questions/history/QuestionHistoryLink.tsx` (F08 shipped it with `QUESTION_HISTORY_AVAILABLE = false`; conventions §5.3). *Do:* set `QUESTION_HISTORY_AVAILABLE = true`; change nothing else in the file. F08's question rows already render the link when the constant is true. *Verify:* `npm run build` → exit 0; `node --test src/components/portal/questions/questionRow.test.ts` → pass (F08-AC-24); browser scenario below.
- [x] **P3.T3 Browser**
  - [x] **P3.T3.S1** *Files:* `scripts/qa/check-f12-browser.mjs` (Playwright from `worker/node_modules/playwright`, local app with fixture API responses). Scenarios: loading skeletons; 404 state; no answers; no answers in range + "Show all available history"; custom range validation (no request sent); brand table "x of y", "(n unknown)", "Show 2 more"; engine switch keeps scan; date select; Answer/Citations/Brands on 390 px; citations badges "Your site"/"Competitor: …"; excerpts with `<mark>`; evidence footer stored/expired/withdrawn copy; executions tags Scheduled/Explorer/Legacy and statuses; wording notices; URL restores on reload and back; `data-ph-mask` present; scan report "History" link navigates with "Back to scan report". *Verify:* `node scripts/qa/check-f12-browser.mjs` → "16 passed" (F12-AC-10, 13, 14 UI half).

**Checkpoint:** full suite, build, browser check. Completes F12-AC-10, 11, 13, 14.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `scripts/qa/check-f12-db.mjs` | links-rls, link-scan, link-explore-legacy, link-import, links-retention | 01–05, 12 |
| `src/lib/questions/history/links.test.ts` | RPC args, lazy failure | 05 |
| `src/shared/question-history.test.ts` | ranges, excerpts | 10 |
| `src/lib/questions/history/summary.test.ts` | parity, unknown, explore exclusion | 07 |
| `src/lib/questions/history/history.test.ts`, `answer.test.ts` | facts, statuses, spans, citations, evidence states, no text logs | 06, 08, 13, 14 |
| `src/lib/questions/history/history.route.test.mjs` | routes, tenant isolation, contract | 06, 08, 13 |
| `src/lib/questions/history/evidenceRoute.route.test.mjs` | explore ownership, unchanged copy | 09 |
| `src/lib/questions/history/reportLinks.route.test.mjs`, `src/components/portal/scans/reportHistoryLinks.test.mjs`, `src/components/portal/portalRegressions.test.mjs` | report links | 11 |
| `scripts/qa/check-f12-browser.mjs` | UI states | 10, 13, 14 |

Fixtures are synthetic; no provider calls. Answer texts in fixtures are short invented sentences naming fictional brands plus the Offcult competitor names already public in the handoff.

## 10. Rollout and rollback

- **Env vars:** none new.
- **Migration order:** 095 after F08's 075–079 (enforced by the guard). Additive.
- **Owner steps after phase 1 deploy:** run the backfill SQL once (§6.1) in the Supabase SQL editor; record the returned counts (numbers only) in the PR. Make sure `FEATURE_JOBS_TICK` is on so `questions.link` runs.
- **Turn off:** remove the page's entry points (revert phase 3); the routes are read-only. To stop linking, the periodic can be disabled by reverting `jobs.ts`.
- **Rollback:** revert code; the link table is inert without readers. `truncate question_answer_links;` is safe (links are rebuilt by the backfill), never needed for rollback.
- **Data cleanup:** retention job (395 days).

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | F12 needs F08 to expose a SQL normaliser identical to the one behind `workspace_questions.text_normalized`. | Requested from F08: `public.normalize_question_text(p text) RETURNS text IMMUTABLE` is defined by F08 (§6.1) as `lower(btrim(regexp_replace(p, '\s+', ' ', 'g')))`: collapse whitespace, then trim, then lowercase. F12 uses F08's function as-is and never redefines it; it backs F08's `text_normalized` column. Migration 095 refuses to apply without it. |
| 2 | F08's panel payload must carry `question_id` per prompt for exact cross-version identity. | Requested from F08 (`payload.prompts[].question_id`). Until then the text fallback links by normalised text. |
| 3 | Importing archived questions writes to F08's table. | Only with `p_import_missing = true` (owner backfill), `origin 'import'`, `status 'archived'`, `topic 'General'`; requested that F08 accept these values and compute `text_normalized` and `branded` defaults for such inserts. |
| 4 | Case differences: OpenSEO preserves case for prompts; our normaliser lower-cases, so "Go vs go" merge into one question. | Accept (questions are buyer questions, not code). Recorded so F08 decides the normaliser once. |
| 5 | Up to 500 executions per page load: JSON-path projection over `probe_observations` in 5 batches. | Acceptable at current scale (≤ 200 questions × 5 engines × scans). Revisit with a summary table if p95 > 1 s. |
| 6 | `README.md` lists F12 depending only on F05. | F08 must be added to F12's Depends column (requested from the coordinator). |
| 7 | Explore answers use the model API; mixing them into rates would mix methods. | Listed, never counted (copy says so). |
| 8 | Legacy rows lack evidence and judged spans in some cases. | Shown as "quality unknown"; excerpts appear only when `raw.brands[].spans` exist. |

**Deviations from conventions:** none.

## 12. Definition of done

- [x] Phases 1–3 merged with their checkpoints green.
- [x] F12-AC-01 … F12-AC-14 covered by passing tests in §9.
- [x] `npm test`, `npm run typecheck`, `npm run build` green; CI `customer-database` green including `check-f12-db.mjs` groups.
- [x] Owner backfill run recorded (counts only).
- [x] `THIRD_PARTY_NOTICES.md` lists every ported file.
- [x] `features/README.md` F12 status updated, and F08 added to its Depends column.
