-- F25: outbox claim, milestone candidates (tolerant of optional tables), retention.

CREATE OR REPLACE FUNCTION public.claim_email_outbox(p_limit integer, p_owner text)
RETURNS SETOF public.email_outbox LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.email_outbox o
     SET status = 'sending', attempts = o.attempts + 1, claimed_by = p_owner,
         claimed_until = now() + interval '5 minutes'
   WHERE o.id IN (
     SELECT id FROM public.email_outbox
      WHERE ((status = 'pending' AND next_attempt_at <= now())
          OR (status = 'sending' AND claimed_until < now()))
        AND attempts < 5
      ORDER BY next_attempt_at, created_at
      LIMIT greatest(1, least(p_limit, 50))
      FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
$$;

-- Rows stuck in 'sending' with 5 attempts used are closed as failed.
CREATE OR REPLACE FUNCTION public.close_exhausted_email_outbox()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH done AS (
    UPDATE public.email_outbox SET status = 'failed', error_code = coalesce(error_code, 'attempts_exhausted'),
           claimed_until = NULL, claimed_by = NULL
     WHERE status IN ('pending','sending') AND attempts >= 5
       AND (status = 'pending' OR claimed_until < now())
    RETURNING 1)
  SELECT count(*)::integer FROM done;
$$;

CREATE OR REPLACE FUNCTION public.email_milestone_candidates(p_limit integer)
RETURNS TABLE (brand_key text, milestone text, reached_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  has_schedules boolean := to_regclass('public.scan_schedules') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'scan_schedules' AND column_name = 'managed_by');
  has_audits boolean := to_regclass('public.site_audits') IS NOT NULL;
  has_turns boolean := to_regclass('public.assistant_turns') IS NOT NULL;
  q text;
BEGIN
  q := $q$
    WITH b AS (SELECT cb.brand_key, cb.created_at FROM public.customer_brands cb WHERE cb.is_active),
    c AS (
      SELECT b.brand_key, 'workspace_created'::text AS milestone, b.created_at AS reached_at FROM b
      UNION ALL
      SELECT s.brand_key, 'first_scan_completed', min(s.created_at) FROM public.scans s
        JOIN b ON b.brand_key = s.brand_key GROUP BY s.brand_key
      UNION ALL
      SELECT g.brand_key, 'gsc_connected', min(g.updated_at) FROM public.gsc_connections g
        JOIN b ON b.brand_key = g.brand_key WHERE g.enabled AND g.auth_mode = 'oauth' GROUP BY g.brand_key
      UNION ALL
      SELECT ci.brand, 'draft_approved', min(ci.updated_at) FROM public.content_items ci
        JOIN b ON b.brand_key = ci.brand WHERE ci.status IN ('approved','published') GROUP BY ci.brand
  $q$;
  IF has_schedules THEN
    q := q || $q$ UNION ALL
      SELECT ss.brand, 'schedule_set', coalesce(ss.customer_updated_at, ss.updated_at, now()) FROM public.scan_schedules ss
        JOIN b ON b.brand_key = ss.brand WHERE ss.managed_by = 'customer' AND ss.enabled $q$;
  END IF;
  IF has_audits THEN
    q := q || $q$ UNION ALL
      SELECT a.brand_key, 'audit_run', min(a.completed_at) FROM public.site_audits a
        JOIN b ON b.brand_key = a.brand_key WHERE a.status IN ('completed','partial') AND a.completed_at IS NOT NULL
        GROUP BY a.brand_key $q$;
  END IF;
  IF has_turns THEN
    q := q || $q$ UNION ALL
      SELECT t.brand_key, 'assistant_used', min(t.created_at) FROM public.assistant_turns t
        JOIN b ON b.brand_key = t.brand_key WHERE t.status = 'completed' GROUP BY t.brand_key $q$;
  END IF;
  q := q || $q$ )
    SELECT c.brand_key, c.milestone, c.reached_at FROM c
     WHERE NOT EXISTS (SELECT 1 FROM public.workspace_milestones m
                        WHERE m.brand_key = c.brand_key AND m.milestone = c.milestone)
     ORDER BY c.reached_at NULLS LAST
     LIMIT $1 $q$;
  RETURN QUERY EXECUTE q USING greatest(1, least(p_limit, 2000));
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_email_outbox(p_before timestamptz, p_limit integer)
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM public.email_outbox WHERE id IN (
      SELECT id FROM public.email_outbox
       WHERE status IN ('sent','skipped','failed') AND updated_at < p_before
       LIMIT greatest(1, least(p_limit, 5000)))
    RETURNING 1)
  SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION public.claim_email_outbox(integer, text), public.close_exhausted_email_outbox(),
  public.email_milestone_candidates(integer), public.prune_email_outbox(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox(integer, text), public.close_exhausted_email_outbox(),
  public.email_milestone_candidates(integer), public.prune_email_outbox(timestamptz, integer) TO service_role;
