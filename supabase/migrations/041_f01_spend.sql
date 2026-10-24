-- Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
--   src/server/billing/subscription.ts
-- Modified for Perceev. See THIRD_PARTY_NOTICES.md.

-- F01: spend guard. Estimate -> hold -> call -> settle on real cost.
-- Answer-engine collection is NOT reserved here: claim_probe_dispatch (027/035) stays authoritative.

CREATE TABLE IF NOT EXISTS public.paid_feature_controls (
  feature text PRIMARY KEY CHECK (feature ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'allowlist' CHECK (mode IN ('all','allowlist')),
  brand_allowlist text[] NOT NULL DEFAULT '{}',
  daily_cap_usd numeric(12,6) CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0),
  max_call_usd numeric(12,6) CHECK (max_call_usd IS NULL OR max_call_usd > 0),
  note text CHECK (note IS NULL OR length(note) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
COMMENT ON COLUMN public.paid_feature_controls.daily_cap_usd IS 'Platform-wide UTC-day cap for this feature across all workspaces.';
COMMENT ON COLUMN public.paid_feature_controls.max_call_usd IS 'Refuse any single estimate above this.';

CREATE TABLE IF NOT EXISTS public.workspace_spend_limits (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  daily_cap_usd numeric(12,6) CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0),
  monthly_cap_usd numeric(12,6) CHECK (monthly_cap_usd IS NULL OR monthly_cap_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
COMMENT ON TABLE public.workspace_spend_limits IS 'No row = env defaults SPEND_DEFAULT_DAILY_CAP_USD / SPEND_DEFAULT_MONTHLY_CAP_USD; unset = no cap.';

CREATE TABLE IF NOT EXISTS public.spend_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  job_id uuid,
  subject_kind text CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z_]+$'),
  subject_id text,
  estimate_usd numeric(12,6) NOT NULL CHECK (estimate_usd > 0),
  max_usd numeric(12,6) CHECK (max_usd IS NULL OR max_usd > 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released','expired')),
  actual_usd numeric(12,6) CHECK (actual_usd IS NULL OR actual_usd >= 0),
  release_reason text CHECK (release_reason IS NULL OR length(release_reason) <= 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT spend_holds_idem UNIQUE (brand_key, idempotency_key),
  CONSTRAINT spend_holds_closed CHECK ((status = 'held') = (closed_at IS NULL))
);
COMMENT ON COLUMN public.spend_holds.job_id IS 'jobs.id when reserved inside a job step. No FK: jobs are pruned after 30 days.';
COMMENT ON COLUMN public.spend_holds.subject_kind IS 'Optional link, e.g. scan_job (F03/F09).';
CREATE INDEX IF NOT EXISTS spend_holds_open_idx ON public.spend_holds (brand_key, created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_feature_open_idx ON public.spend_holds (feature, created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_expiry_idx ON public.spend_holds (expires_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_subject_idx ON public.spend_holds (subject_kind, subject_id) WHERE subject_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.spend_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature text NOT NULL,
  hold_id uuid REFERENCES public.spend_holds(id) ON DELETE SET NULL,
  job_id uuid,
  source_ref text NOT NULL UNIQUE CHECK (length(source_ref) BETWEEN 1 AND 300),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 60),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 200),
  units numeric(14,4) CHECK (units IS NULL OR units >= 0),
  estimate_usd numeric(12,6) CHECK (estimate_usd IS NULL OR estimate_usd >= 0),
  actual_usd numeric(12,6) CHECK (actual_usd IS NULL OR actual_usd >= 0),
  accounted_usd numeric(12,6) NOT NULL CHECK (accounted_usd >= 0),
  cost_source text NOT NULL CHECK (cost_source IN ('provider_reported','price_table','reservation','none')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(meta) < 8192),
  CONSTRAINT spend_ledger_accounting CHECK (
    (cost_source = 'none' AND accounted_usd = 0 AND coalesce(actual_usd, 0) = 0)
    OR (cost_source IN ('provider_reported','price_table') AND actual_usd IS NOT NULL AND accounted_usd = actual_usd)
    OR (cost_source = 'reservation' AND actual_usd IS NULL AND accounted_usd = coalesce(estimate_usd, 0)))
);
COMMENT ON COLUMN public.spend_ledger.accounted_usd IS 'What counts against caps: the actual cost, or the estimate when the cost is unknown.';
COMMENT ON COLUMN public.spend_ledger.source_ref IS 'Idempotency: hold:<uuid>[:<n>] (F01) or probe_attempt:<observation>:<attempt> (F03).';
CREATE INDEX IF NOT EXISTS spend_ledger_brand_time_idx ON public.spend_ledger (brand_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS spend_ledger_feature_time_idx ON public.spend_ledger (feature, occurred_at DESC);
CREATE INDEX IF NOT EXISTS spend_ledger_hold_idx ON public.spend_ledger (hold_id) WHERE hold_id IS NOT NULL;

ALTER TABLE public.paid_feature_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_spend_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spend_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spend_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_feature_controls, public.workspace_spend_limits, public.spend_holds, public.spend_ledger
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.paid_feature_controls, public.workspace_spend_limits, public.spend_holds, public.spend_ledger
  TO service_role;
GRANT SELECT ON public.workspace_spend_limits, public.spend_holds, public.spend_ledger TO authenticated;
DROP POLICY IF EXISTS workspace_spend_limits_read ON public.workspace_spend_limits;
CREATE POLICY workspace_spend_limits_read ON public.workspace_spend_limits FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS spend_holds_read ON public.spend_holds;
CREATE POLICY spend_holds_read ON public.spend_holds FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS spend_ledger_read ON public.spend_ledger;
CREATE POLICY spend_ledger_read ON public.spend_ledger FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

-- Seed F01's only feature, disabled.
INSERT INTO public.paid_feature_controls(feature, enabled, mode, note)
VALUES ('platform.selftest', false, 'allowlist', 'Owner-run LLM helper live check (scripts/qa/check-f01-live.mjs).')
ON CONFLICT (feature) DO NOTHING;

-- Committed spend = settled/expired ledger + open holds (at estimate).
CREATE OR REPLACE FUNCTION public.f01_committed_usd(p_brand text, p_feature text, p_since timestamptz)
RETURNS numeric LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce((SELECT sum(accounted_usd) FROM spend_ledger
                    WHERE occurred_at >= p_since
                      AND (p_brand IS NULL OR brand_key = p_brand)
                      AND (p_feature IS NULL OR feature = p_feature)), 0)
       + coalesce((SELECT sum(estimate_usd) FROM spend_holds
                    WHERE status = 'held'
                      AND (p_brand IS NULL OR brand_key = p_brand)
                      AND (p_feature IS NULL OR feature = p_feature)), 0);
$$;

CREATE OR REPLACE FUNCTION public.reserve_spend(
  p_brand text, p_feature text, p_estimate numeric, p_max numeric, p_idempotency text,
  p_job uuid, p_subject_kind text, p_subject_id text, p_ttl_seconds integer,
  p_default_daily numeric, p_default_monthly numeric)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c paid_feature_controls; l workspace_spend_limits; h spend_holds;
  v_day timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_daily numeric; v_monthly numeric; v_id uuid;
BEGIN
  IF p_estimate IS NULL OR p_estimate <= 0 THEN RAISE EXCEPTION 'estimate must be positive'; END IF;
  IF p_ttl_seconds < 60 OR p_ttl_seconds > 86340 THEN RAISE EXCEPTION 'invalid hold ttl'; END IF;
  -- Serialise per workspace and per feature: reservations race on caps, never on the network.
  PERFORM pg_advisory_xact_lock(hashtext('f01:spend:brand:' || p_brand));
  PERFORM pg_advisory_xact_lock(hashtext('f01:spend:feature:' || p_feature));
  SELECT * INTO h FROM spend_holds WHERE brand_key = p_brand AND idempotency_key = p_idempotency;
  IF FOUND THEN
    IF h.status = 'held' THEN RETURN jsonb_build_object('granted', true, 'hold_id', h.id, 'existing', true); END IF;
    RETURN jsonb_build_object('granted', false, 'reason', 'duplicate_paid_call', 'hold_id', h.id);
  END IF;
  SELECT * INTO c FROM paid_feature_controls WHERE feature = p_feature;
  IF NOT FOUND OR NOT c.enabled OR (c.mode = 'allowlist' AND NOT (p_brand = ANY(c.brand_allowlist))) THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'feature_disabled');
  END IF;
  IF p_max IS NOT NULL AND p_estimate > p_max THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'over_approved_max', 'estimate_usd', p_estimate);
  END IF;
  IF c.max_call_usd IS NOT NULL AND p_estimate > c.max_call_usd THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'over_approved_max', 'estimate_usd', p_estimate,
                              'limit_usd', c.max_call_usd);
  END IF;
  IF c.daily_cap_usd IS NOT NULL AND f01_committed_usd(NULL, p_feature, v_day) + p_estimate > c.daily_cap_usd THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'daily_cap', 'scope', 'feature');
  END IF;
  SELECT * INTO l FROM workspace_spend_limits WHERE brand_key = p_brand;
  v_daily := CASE WHEN FOUND THEN l.daily_cap_usd ELSE p_default_daily END;
  v_monthly := CASE WHEN FOUND THEN l.monthly_cap_usd ELSE p_default_monthly END;
  IF v_daily IS NOT NULL AND f01_committed_usd(p_brand, NULL, v_day) + p_estimate > v_daily THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'daily_cap', 'scope', 'workspace', 'limit_usd', v_daily);
  END IF;
  IF v_monthly IS NOT NULL AND f01_committed_usd(p_brand, NULL, v_month) + p_estimate > v_monthly THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'workspace_cap', 'limit_usd', v_monthly);
  END IF;
  INSERT INTO spend_holds(brand_key, feature, idempotency_key, job_id, subject_kind, subject_id,
                          estimate_usd, max_usd, expires_at)
  VALUES (p_brand, p_feature, p_idempotency, p_job, p_subject_kind, p_subject_id, p_estimate, p_max,
          now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('granted', true, 'hold_id', v_id, 'existing', false);
END $$;

-- Settle a hold with one or more cost rows (OpenSEO: one hold, each call credited separately).
-- p_costs: [{provider, endpoint, units?, actual_usd|null, cost_source, suffix?, meta?}]
CREATE OR REPLACE FUNCTION public.settle_spend(p_hold uuid, p_costs jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds; r jsonb; i integer := 0; v_actual numeric := 0; v_unknown boolean := false;
  v_rows integer; v_est numeric; v_cost numeric; v_src text;
BEGIN
  SELECT * INTO h FROM spend_holds WHERE id = p_hold FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hold not found'; END IF;
  IF h.status <> 'held' THEN RETURN jsonb_build_object('settled', false, 'status', h.status); END IF;
  v_rows := jsonb_array_length(p_costs);
  IF v_rows < 1 OR v_rows > 200 THEN RAISE EXCEPTION 'settle needs 1..200 cost rows'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_costs) LOOP
    i := i + 1;
    v_cost := (r->>'actual_usd')::numeric;
    v_src := r->>'cost_source';
    IF v_cost IS NOT NULL AND v_cost < 0 THEN RAISE EXCEPTION 'negative cost'; END IF;
    -- Unknown cost rows are counted at their share of the estimate.
    v_est := round(h.estimate_usd / v_rows, 6);
    IF v_cost IS NULL THEN v_unknown := true; v_src := 'reservation'; ELSE v_actual := v_actual + v_cost; END IF;
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint, units,
                             estimate_usd, actual_usd, accounted_usd, cost_source, meta)
    VALUES (h.brand_key, h.feature, h.id, h.job_id,
            'hold:' || h.id || CASE WHEN v_rows > 1 THEN ':' || i ELSE '' END,
            r->>'provider', r->>'endpoint', (r->>'units')::numeric, v_est, v_cost,
            coalesce(v_cost, v_est), v_src, coalesce(r->'meta', '{}'::jsonb)
              || jsonb_build_object('undershoot', v_cost IS NOT NULL AND v_cost > v_est))
    ON CONFLICT (source_ref) DO NOTHING;
  END LOOP;
  UPDATE spend_holds SET status = 'settled', actual_usd = CASE WHEN v_unknown THEN NULL ELSE v_actual END,
         closed_at = now() WHERE id = p_hold;
  RETURN jsonb_build_object('settled', true, 'actual_usd', v_actual, 'unknown', v_unknown,
    'undershoot', v_actual > h.estimate_usd, 'over_max', h.max_usd IS NOT NULL AND v_actual > h.max_usd);
END $$;

CREATE OR REPLACE FUNCTION public.release_spend(p_hold uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE spend_holds SET status = 'released', release_reason = left(p_reason, 200), closed_at = now(),
         actual_usd = 0 WHERE id = p_hold AND status = 'held';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.expire_spend_holds(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds; v integer := 0;
BEGIN
  FOR h IN SELECT * FROM spend_holds WHERE status = 'held' AND expires_at < now()
            ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint,
                             estimate_usd, actual_usd, accounted_usd, cost_source, meta)
    VALUES (h.brand_key, h.feature, h.id, h.job_id, 'hold:' || h.id, 'unknown', 'expired_hold',
            h.estimate_usd, NULL, h.estimate_usd, 'reservation', jsonb_build_object('expired', true))
    ON CONFLICT (source_ref) DO NOTHING;
    UPDATE spend_holds SET status = 'expired', closed_at = now() WHERE id = h.id;
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.prune_spend(p_holds_before timestamptz, p_ledger_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_l integer; v_h integer;
BEGIN
  WITH old AS (SELECT id FROM spend_ledger WHERE occurred_at < p_ledger_before ORDER BY occurred_at LIMIT p_limit)
  DELETE FROM spend_ledger s USING old WHERE s.id = old.id;
  GET DIAGNOSTICS v_l = ROW_COUNT;
  WITH old AS (SELECT id FROM spend_holds WHERE status <> 'held' AND closed_at < p_holds_before
                ORDER BY closed_at LIMIT p_limit)
  DELETE FROM spend_holds s USING old WHERE s.id = old.id;
  GET DIAGNOSTICS v_h = ROW_COUNT;
  RETURN jsonb_build_object('ledger', v_l, 'holds', v_h);
END $$;

REVOKE ALL ON FUNCTION public.f01_committed_usd(text,text,timestamptz),
  public.reserve_spend(text,text,numeric,numeric,text,uuid,text,text,integer,numeric,numeric),
  public.settle_spend(uuid,jsonb), public.release_spend(uuid,text), public.expire_spend_holds(integer),
  public.prune_spend(timestamptz,timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f01_committed_usd(text,text,timestamptz),
  public.reserve_spend(text,text,numeric,numeric,text,uuid,text,text,integer,numeric,numeric),
  public.settle_spend(uuid,jsonb), public.release_spend(uuid,text), public.expire_spend_holds(integer),
  public.prune_spend(timestamptz,timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
