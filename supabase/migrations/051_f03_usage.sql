-- F03: read functions for the customer Usage page and the operator cost view. Service role only.
CREATE OR REPLACE FUNCTION public.workspace_usage_days(p_brand text, p_from timestamptz, p_to timestamptz, p_tz text)
RETURNS TABLE(day date, feature text, accounted_usd numeric, known_usd numeric, unknown_usd numeric, calls integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT (occurred_at AT TIME ZONE p_tz)::date, feature,
         sum(accounted_usd),
         coalesce(sum(actual_usd) FILTER (WHERE cost_source IN ('provider_reported','price_table')), 0),
         coalesce(sum(accounted_usd) FILTER (WHERE cost_source = 'reservation'), 0),
         count(*) FILTER (WHERE cost_source <> 'none')::integer
    FROM spend_ledger
   WHERE brand_key = p_brand AND occurred_at >= p_from AND occurred_at < p_to
   GROUP BY 1, 2 ORDER BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION public.workspace_spend_position(p_brand text, p_default_daily numeric, p_default_monthly numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE l workspace_spend_limits; v_has boolean;
  v_day timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  SELECT * INTO l FROM workspace_spend_limits WHERE brand_key = p_brand; v_has := FOUND;
  RETURN jsonb_build_object(
    'today_usd', f01_committed_usd(p_brand, NULL, v_day),
    'month_usd', f01_committed_usd(p_brand, NULL, v_month),
    'daily_cap_usd', CASE WHEN v_has THEN l.daily_cap_usd ELSE p_default_daily END,
    'monthly_cap_usd', CASE WHEN v_has THEN l.monthly_cap_usd ELSE p_default_monthly END,
    'open_holds_usd', coalesce((SELECT sum(estimate_usd) FROM spend_holds WHERE brand_key = p_brand AND status = 'held'), 0),
    'open_holds', (SELECT count(*) FROM spend_holds WHERE brand_key = p_brand AND status = 'held'),
    'day_starts_at', v_day, 'month_starts_at', v_month);
END $$;

CREATE OR REPLACE FUNCTION public.operator_costs_by_workspace(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(brand_key text, feature text, accounted_usd numeric, known_usd numeric, unknown_usd numeric,
              calls integer, open_reconciliations integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.brand_key, l.feature, sum(l.accounted_usd),
         coalesce(sum(l.actual_usd) FILTER (WHERE l.cost_source IN ('provider_reported','price_table')), 0),
         coalesce(sum(l.accounted_usd) FILTER (WHERE l.cost_source = 'reservation'), 0),
         count(*)::integer,
         (SELECT count(*)::integer FROM cost_reconciliations c
           WHERE c.brand_key = l.brand_key AND c.feature = l.feature AND c.resolution IS NULL)
    FROM spend_ledger l WHERE l.occurred_at >= p_from AND l.occurred_at < p_to
   GROUP BY l.brand_key, l.feature ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION public.operator_costs_by_endpoint(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(provider text, endpoint text, calls integer, estimate_usd numeric, actual_usd numeric,
              unknown_calls integer, undershoots integer, max_ratio numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT provider, endpoint, count(*)::integer,
         coalesce(sum(estimate_usd), 0), coalesce(sum(actual_usd), 0),
         count(*) FILTER (WHERE cost_source = 'reservation')::integer,
         count(*) FILTER (WHERE actual_usd > estimate_usd)::integer,
         max(round(actual_usd / nullif(estimate_usd, 0), 4))
    FROM spend_ledger WHERE occurred_at >= p_from AND occurred_at < p_to AND cost_source <> 'none'
   GROUP BY provider, endpoint ORDER BY 7 DESC, 5 DESC;
$$;

REVOKE ALL ON FUNCTION public.workspace_usage_days(text,timestamptz,timestamptz,text),
  public.workspace_spend_position(text,numeric,numeric),
  public.operator_costs_by_workspace(timestamptz,timestamptz),
  public.operator_costs_by_endpoint(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_usage_days(text,timestamptz,timestamptz,text),
  public.workspace_spend_position(text,numeric,numeric),
  public.operator_costs_by_workspace(timestamptz,timestamptz),
  public.operator_costs_by_endpoint(timestamptz,timestamptz) TO service_role;
NOTIFY pgrst, 'reload schema';
