-- 126: F18 site audit functions — atomic start, frontier claims (scratchpad port), finalize link checks,
-- summaries, usage and retention. All service-role only. Safe to re-run.

-- Atomic start: one active audit per workspace, at most p_host_cap active audits per host across workspaces,
-- and a monthly page allowance, checked under the workspace row lock (OpenSEO checks after insert,
-- AuditService.ts:109-125; a row lock gives the same race safety).
CREATE OR REPLACE FUNCTION public.site_audit_create(
  p_id uuid, p_brand_key text, p_started_by uuid, p_trigger text, p_requested_url text, p_start_url text,
  p_start_host text, p_max_pages integer, p_lighthouse boolean, p_render boolean,
  p_month_start timestamptz, p_monthly_cap integer, p_host_cap integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_active uuid; v_host integer; v_used integer;
BEGIN
  PERFORM 1 FROM customer_brands WHERE brand_key = p_brand_key AND is_active FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('created', false, 'reason', 'workspace_not_found'); END IF;
  SELECT id INTO v_active FROM site_audits WHERE brand_key = p_brand_key AND status IN ('queued','running') LIMIT 1;
  IF v_active IS NOT NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'audit_already_running', 'activeAuditId', v_active);
  END IF;
  SELECT count(*) INTO v_host FROM site_audits WHERE start_host = p_start_host AND status IN ('queued','running');
  IF v_host >= p_host_cap THEN RETURN jsonb_build_object('created', false, 'reason', 'host_busy'); END IF;
  SELECT coalesce(sum(CASE WHEN status IN ('queued','running') THEN max_pages ELSE pages_crawled END), 0)::integer
    INTO v_used FROM site_audits WHERE brand_key = p_brand_key AND created_at >= p_month_start;
  IF v_used + p_max_pages > p_monthly_cap THEN
    RETURN jsonb_build_object('created', false, 'reason', 'audit_capacity_reached', 'used', v_used, 'cap', p_monthly_cap);
  END IF;
  INSERT INTO site_audits (id, brand_key, started_by, trigger, requested_url, start_url, start_host, max_pages,
                           run_lighthouse, render_javascript, pages_total)
  VALUES (p_id, p_brand_key, p_started_by, p_trigger, p_requested_url, p_start_url, p_start_host, p_max_pages,
          p_lighthouse, p_render, p_max_pages);
  RETURN jsonb_build_object('created', true, 'used', v_used + p_max_pages, 'cap', p_monthly_cap);
END $$;

CREATE OR REPLACE FUNCTION public.site_audit_seed(p_audit_id uuid, p_urls text[], p_source text)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_source = 'link' THEN
    INSERT INTO site_audit_frontier (audit_id, url, depth, source, in_sitemap)
    SELECT DISTINCT p_audit_id, u, 0, 'link', false FROM unnest(p_urls) AS u
    ON CONFLICT (audit_id, url) DO NOTHING;
  ELSIF p_source = 'sitemap' THEN
    -- Upsert: a URL already queued (e.g. the start URL) keeps position and depth but gains the sitemap flag
    -- (AuditScratchpad.ts:132-142).
    INSERT INTO site_audit_frontier (audit_id, url, depth, source, in_sitemap)
    SELECT DISTINCT p_audit_id, u, NULL::integer, 'sitemap', true FROM unnest(p_urls) AS u
    ON CONFLICT (audit_id, url) DO UPDATE SET in_sitemap = true;
  ELSE
    RAISE EXCEPTION 'site_audit_seed: invalid source %', p_source;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.site_audit_frontier_stats(p_audit_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'attempted', count(*) FILTER (WHERE state = 'crawled'),
    'pending',   count(*) FILTER (WHERE state = 'pending'),
    'abandoned', count(*) FILTER (WHERE state = 'abandoned'),
    'seen',      count(*))
  FROM site_audit_frontier WHERE audit_id = p_audit_id
$$;

-- Lease the next chunk. Idempotent per chunk number (AuditScratchpad.ts:150-183).
CREATE OR REPLACE FUNCTION public.site_audit_claim_chunk(p_audit_id uuid, p_chunk_no integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  PERFORM 1 FROM site_audits WHERE id = p_audit_id FOR UPDATE;   -- serialise claims for one audit
  SELECT coalesce(jsonb_agg(jsonb_build_object('url', f.url, 'depth', f.depth, 'inSitemap', f.in_sitemap)
                            ORDER BY f.source, f.seq), '[]'::jsonb)
    INTO v FROM site_audit_frontier f
   WHERE f.audit_id = p_audit_id AND f.state = 'leased' AND f.chunk_no = p_chunk_no;
  IF jsonb_array_length(v) > 0 THEN RETURN jsonb_build_object('isRetry', true, 'urls', v); END IF;
  IF EXISTS (SELECT 1 FROM site_audit_frontier WHERE audit_id = p_audit_id AND chunk_no = p_chunk_no
             AND state IN ('crawled','abandoned')) THEN
    RETURN jsonb_build_object('isRetry', true, 'urls', '[]'::jsonb);
  END IF;
  IF p_limit <= 0 THEN RETURN jsonb_build_object('isRetry', false, 'urls', '[]'::jsonb); END IF;
  WITH picked AS (
    SELECT url FROM site_audit_frontier
     WHERE audit_id = p_audit_id AND state = 'pending'
     ORDER BY source, seq            -- 'link' sorts before 'sitemap'
     LIMIT p_limit
  ), leased AS (
    UPDATE site_audit_frontier f SET state = 'leased', chunk_no = p_chunk_no
      FROM picked WHERE f.audit_id = p_audit_id AND f.url = picked.url
    RETURNING f.url, f.depth, f.in_sitemap, f.source, f.seq
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('url', url, 'depth', depth, 'inSitemap', in_sitemap)
                            ORDER BY source, seq), '[]'::jsonb) INTO v FROM leased;
  RETURN jsonb_build_object('isRetry', false, 'urls', v);
END $$;

-- Persist one crawled sub-batch's frontier side (AuditScratchpad.recordBatch).
-- p_links: [{"pageId": uuid, "url": text, "targets": [text, ...]}]; p_discovered: [{"url": text, "depth": int|null}]
CREATE OR REPLACE FUNCTION public.site_audit_record_batch(p_audit_id uuid, p_crawled text[], p_links jsonb,
  p_discovered jsonb, p_link_budget integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_stored integer; v_incoming integer; v_existing integer; v_new integer;
BEGIN
  UPDATE site_audit_frontier SET state = 'crawled'
   WHERE audit_id = p_audit_id AND url = ANY (p_crawled) AND state IN ('leased','pending');
  SELECT link_targets_stored INTO v_stored FROM site_audits WHERE id = p_audit_id FOR UPDATE;
  SELECT coalesce(sum(jsonb_array_length(l -> 'targets')), 0)::integer INTO v_incoming
    FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) l;
  SELECT coalesce(sum(coalesce(cardinality(target_hashes), 0)), 0)::integer INTO v_existing
    FROM site_audit_links
   WHERE audit_id = p_audit_id
     AND page_id IN (SELECT (l ->> 'pageId')::uuid FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) l);
  v_new := v_incoming - v_existing;
  IF v_stored + v_new <= p_link_budget THEN
    INSERT INTO site_audit_links (audit_id, page_id, url, target_hashes)
    SELECT p_audit_id, (l ->> 'pageId')::uuid, l ->> 'url',
           ARRAY(SELECT hashtextextended(t, 0) FROM jsonb_array_elements_text(l -> 'targets') t)
      FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) l
    ON CONFLICT (audit_id, page_id) DO UPDATE SET url = excluded.url, target_hashes = excluded.target_hashes;
    UPDATE site_audits SET link_targets_stored = link_targets_stored + v_new WHERE id = p_audit_id;
  ELSIF v_new > 0 THEN
    UPDATE site_audits SET link_graph_complete = false WHERE id = p_audit_id;
  END IF;
  -- Link discovery: new URLs queue as 'link'; a pending depth-less sitemap seed takes the link's depth and
  -- priority (scratchpad-sql.ts:60-65).
  INSERT INTO site_audit_frontier (audit_id, url, depth, source, in_sitemap)
  SELECT p_audit_id, d.url, d.depth, 'link', false FROM (
    SELECT DISTINCT ON (x ->> 'url') x ->> 'url' AS url, (x ->> 'depth')::integer AS depth
      FROM jsonb_array_elements(coalesce(p_discovered, '[]'::jsonb)) x
     ORDER BY x ->> 'url', (x ->> 'depth')::integer NULLS LAST) d
  ON CONFLICT (audit_id, url) DO UPDATE SET source = 'link', depth = excluded.depth
   WHERE site_audit_frontier.state = 'pending' AND site_audit_frontier.depth IS NULL AND excluded.depth IS NOT NULL;
  RETURN site_audit_frontier_stats(p_audit_id);
END $$;

CREATE OR REPLACE FUNCTION public.site_audit_release(p_audit_id uuid, p_urls text[])
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE site_audit_frontier SET state = 'pending', chunk_no = NULL
   WHERE audit_id = p_audit_id AND url = ANY (p_urls) AND state = 'leased';
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

-- A billed (rendering) chunk that failed is never re-fetched: its unpersisted leases are abandoned.
CREATE OR REPLACE FUNCTION public.site_audit_abandon_chunk(p_audit_id uuid, p_chunk_no integer)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE site_audit_frontier SET state = 'abandoned'
   WHERE audit_id = p_audit_id AND chunk_no = p_chunk_no AND state = 'leased';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE site_audits SET pages_abandoned = pages_abandoned + n WHERE id = p_audit_id;
  RETURN n;
END $$;

-- Broken internal links: only targets we crawled and saw fail; WAF-blocked targets excluded (scratchpad-sql.ts:67-90).
CREATE OR REPLACE FUNCTION public.site_audit_broken_links(p_audit_id uuid, p_limit integer DEFAULT 2000)
RETURNS TABLE (source_page_id uuid, source_url text, target_url text, target_status integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.page_id, l.url, t.url, t.status_code
    FROM site_audit_links l
    CROSS JOIN LATERAL unnest(l.target_hashes) AS h(hash)
    JOIN site_audit_pages t ON t.audit_id = l.audit_id AND t.url_hash = h.hash
   WHERE l.audit_id = p_audit_id AND t.status_code >= 400 AND t.fetch_class = 'ok'
   ORDER BY l.page_id, t.url
   LIMIT p_limit
$$;

-- Orphans: live 2xx pages no OTHER crawled page links to and nothing redirects to (scratchpad-sql.ts:92-118).
-- The caller only invokes this when the crawl completed and link_graph_complete is true.
CREATE OR REPLACE FUNCTION public.site_audit_orphan_pages(p_audit_id uuid, p_start_url text)
RETURNS TABLE (page_id uuid, url text)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH inbound AS (
    SELECT DISTINCT h.hash
      FROM site_audit_links l CROSS JOIN LATERAL unnest(l.target_hashes) AS h(hash)
     WHERE l.audit_id = p_audit_id AND h.hash <> hashtextextended(l.url, 0)
  )
  SELECT p.id, p.url FROM site_audit_pages p
   WHERE p.audit_id = p_audit_id AND p.url <> p_start_url AND p.fetch_class = 'ok'
     AND p.status_code BETWEEN 200 AND 299
     AND NOT EXISTS (SELECT 1 FROM inbound i WHERE i.hash = p.url_hash)
     AND NOT EXISTS (SELECT 1 FROM site_audit_pages r WHERE r.audit_id = p_audit_id AND r.redirect_url = p.url)
$$;

-- Distinct pages per issue type (auditSummaryQueries.ts:11-21).
CREATE OR REPLACE FUNCTION public.site_audit_issue_summary(p_audit_id uuid)
RETURNS TABLE (issue_type text, severity text, pages bigint, rows_count bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT issue_type, severity, count(DISTINCT page_url), count(*)
    FROM site_audit_issues WHERE audit_id = p_audit_id GROUP BY issue_type, severity
$$;

CREATE OR REPLACE FUNCTION public.site_audit_destroy_scratch(p_audit_id uuid)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  DELETE FROM site_audit_frontier WHERE audit_id = p_audit_id;
  DELETE FROM site_audit_links WHERE audit_id = p_audit_id;
$$;

-- Retention: audits older than p_audits_before (395 days) and scratch rows of audits finished before
-- p_scratch_before (7 days; the scratchpad alarm, AuditScratchpad.ts:95). Returns deleted audits for Storage cleanup.
CREATE OR REPLACE FUNCTION public.prune_site_audits(p_audits_before timestamptz, p_scratch_before timestamptz,
  p_limit integer DEFAULT 200)
RETURNS TABLE (audit_id uuid, brand_key text)
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM site_audit_frontier f USING site_audits a
   WHERE f.audit_id = a.id AND a.status NOT IN ('queued','running') AND a.completed_at < p_scratch_before;
  DELETE FROM site_audit_links l USING site_audits a
   WHERE l.audit_id = a.id AND a.status NOT IN ('queued','running') AND a.completed_at < p_scratch_before;
  RETURN QUERY
  WITH old AS (
    SELECT id FROM site_audits WHERE created_at < p_audits_before AND status NOT IN ('queued','running')
     ORDER BY created_at LIMIT p_limit)
  DELETE FROM site_audits s USING old WHERE s.id = old.id RETURNING s.id, s.brand_key;
END $$;

REVOKE ALL ON FUNCTION
  public.site_audit_create(uuid,text,uuid,text,text,text,text,integer,boolean,boolean,timestamptz,integer,integer),
  public.site_audit_seed(uuid,text[],text), public.site_audit_frontier_stats(uuid),
  public.site_audit_claim_chunk(uuid,integer,integer), public.site_audit_record_batch(uuid,text[],jsonb,jsonb,integer),
  public.site_audit_release(uuid,text[]), public.site_audit_abandon_chunk(uuid,integer),
  public.site_audit_broken_links(uuid,integer), public.site_audit_orphan_pages(uuid,text),
  public.site_audit_issue_summary(uuid), public.site_audit_destroy_scratch(uuid),
  public.prune_site_audits(timestamptz,timestamptz,integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.site_audit_create(uuid,text,uuid,text,text,text,text,integer,boolean,boolean,timestamptz,integer,integer),
  public.site_audit_seed(uuid,text[],text), public.site_audit_frontier_stats(uuid),
  public.site_audit_claim_chunk(uuid,integer,integer), public.site_audit_record_batch(uuid,text[],jsonb,jsonb,integer),
  public.site_audit_release(uuid,text[]), public.site_audit_abandon_chunk(uuid,integer),
  public.site_audit_broken_links(uuid,integer), public.site_audit_orphan_pages(uuid,text),
  public.site_audit_issue_summary(uuid), public.site_audit_destroy_scratch(uuid),
  public.prune_site_audits(timestamptz,timestamptz,integer)
TO service_role;
NOTIFY pgrst, 'reload schema';
