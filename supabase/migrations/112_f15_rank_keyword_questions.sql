-- F15 Phase 6: Links tracked keywords to AI questions; latest Google AI Overview verdict per question.

DO $$ BEGIN
  IF to_regclass('public.workspace_questions') IS NULL THEN
    RAISE EXCEPTION 'F15 phase 6 requires F08: workspace_questions';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.rank_keyword_questions (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  tracking_keyword_id uuid NOT NULL REFERENCES public.rank_tracking_keywords(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.workspace_questions(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tracking_keyword_id, question_id)
);

CREATE INDEX IF NOT EXISTS rank_keyword_questions_brand_idx ON public.rank_keyword_questions (brand_key, question_id);

ALTER TABLE public.rank_keyword_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rank_keyword_questions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rank_keyword_questions TO service_role;
GRANT SELECT ON public.rank_keyword_questions TO authenticated;

DROP POLICY IF EXISTS rank_keyword_questions_read ON public.rank_keyword_questions;
CREATE POLICY rank_keyword_questions_read ON public.rank_keyword_questions FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

-- Latest Google AI Overview observation per question. plpgsql defers name resolution,
-- so this applies before F12's question_answer_links exists; calling it without F12 raises
-- undefined_table, which the service maps to "not_measured".
CREATE OR REPLACE FUNCTION public.rank_question_aio_status(p_brand text, p_question_ids uuid[])
RETURNS TABLE (question_id uuid, collected_at timestamptz, state text, aio_present boolean,
               own_cited boolean, own_mentioned boolean)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (l.question_id) l.question_id, l.collected_at,
         coalesce(o.state, CASE WHEN p.answered THEN 'answered' WHEN p.answered = false THEN 'valid_no_aio' ELSE 'unknown' END),
         coalesce((o.result->>'aio_present')::boolean, p.answered),
         coalesce((o.result->>'brand_cited')::boolean, p.brand_cited),
         coalesce((o.result->>'brand_mentioned_in_text')::boolean, p.mentioned)
    FROM question_answer_links l
    LEFT JOIN probe_observations o ON o.id = l.observation_id
    LEFT JOIN prompt_results p ON p.id = l.prompt_result_id
   WHERE l.brand_key = p_brand AND l.question_id = ANY (p_question_ids) AND l.engine = 'aio'
     AND l.source IN ('scan','legacy')
   ORDER BY l.question_id, l.collected_at DESC;
END $$;

REVOKE ALL ON FUNCTION public.rank_question_aio_status(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rank_question_aio_status(text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
