-- F16: opt-in backlink history per workspace target (port of the unused
-- openseo backlink_snapshots table, app.schema.ts:417-445, made per-scope and scheduled).
CREATE TABLE IF NOT EXISTS public.backlink_snapshot_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  target text NOT NULL CHECK (target = lower(target) AND length(target) BETWEEN 3 AND 255
    AND target ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND target !~ '^www\.'),
  scope text NOT NULL CHECK (scope IN ('domain','subdomains')),
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
  schedule_interval text NOT NULL CHECK (schedule_interval IN ('weekly','monthly')),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd > 0 AND approved_max_usd <= 1000),
  approval_id uuid,
  last_run_at timestamptz,
  last_skip_reason text CHECK (last_skip_reason IS NULL OR length(last_skip_reason) <= 64),
  last_skip_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_snapshot_targets_unique UNIQUE (brand_key, target, scope)
);
COMMENT ON COLUMN public.backlink_snapshot_targets.approval_id IS 'F09 price approval row (source schedule) that set approved_max_usd.';
CREATE INDEX IF NOT EXISTS backlink_snapshot_targets_due_idx
  ON public.backlink_snapshot_targets (next_run_at) WHERE enabled;

-- Counts are bigint: large sites exceed 2,147,483,647 backlinks (OpenSEO widened them, 0016_panoramic_blob.sql).
CREATE TABLE IF NOT EXISTS public.backlink_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  target text NOT NULL CHECK (length(target) BETWEEN 3 AND 255),
  scope text NOT NULL CHECK (scope IN ('domain','subdomains')),
  captured_on date NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('scheduled','lookup')),
  rank smallint CHECK (rank IS NULL OR rank BETWEEN 0 AND 100),
  backlinks bigint CHECK (backlinks IS NULL OR backlinks >= 0),
  referring_domains bigint CHECK (referring_domains IS NULL OR referring_domains >= 0),
  referring_pages bigint CHECK (referring_pages IS NULL OR referring_pages >= 0),
  broken_backlinks bigint CHECK (broken_backlinks IS NULL OR broken_backlinks >= 0),
  broken_pages bigint CHECK (broken_pages IS NULL OR broken_pages >= 0),
  new_backlinks bigint CHECK (new_backlinks IS NULL OR new_backlinks >= 0),
  lost_backlinks bigint CHECK (lost_backlinks IS NULL OR lost_backlinks >= 0),
  new_referring_domains bigint CHECK (new_referring_domains IS NULL OR new_referring_domains >= 0),
  lost_referring_domains bigint CHECK (lost_referring_domains IS NULL OR lost_referring_domains >= 0),
  backlinks_spam_score smallint CHECK (backlinks_spam_score IS NULL OR backlinks_spam_score BETWEEN 0 AND 100),
  target_spam_score smallint CHECK (target_spam_score IS NULL OR target_spam_score BETWEEN 0 AND 100),
  CONSTRAINT backlink_snapshots_one_per_day UNIQUE (brand_key, target, scope, captured_on)
);
CREATE INDEX IF NOT EXISTS backlink_snapshots_series_idx
  ON public.backlink_snapshots (brand_key, target, scope, captured_on DESC);

DROP TRIGGER IF EXISTS backlink_snapshot_targets_touch ON public.backlink_snapshot_targets;
CREATE TRIGGER backlink_snapshot_targets_touch BEFORE UPDATE ON public.backlink_snapshot_targets
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

-- Cap: 20 enabled targets per workspace (own site plus competitors).
CREATE OR REPLACE FUNCTION public.f16_snapshot_target_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.enabled THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.brand_key, 0));
    IF (SELECT count(*) FROM backlink_snapshot_targets
        WHERE brand_key = NEW.brand_key AND enabled AND id <> NEW.id) >= 20 THEN
      RAISE EXCEPTION 'backlink_snapshots_cap:targets';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS backlink_snapshot_targets_cap ON public.backlink_snapshot_targets;
CREATE TRIGGER backlink_snapshot_targets_cap BEFORE INSERT OR UPDATE OF enabled ON public.backlink_snapshot_targets
  FOR EACH ROW EXECUTE FUNCTION public.f16_snapshot_target_cap();

CREATE OR REPLACE FUNCTION public.prune_backlink_snapshots(p_before date, p_limit integer) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM backlink_snapshots WHERE id IN (
    SELECT id FROM backlink_snapshots WHERE captured_on < p_before LIMIT greatest(1, least(p_limit, 10000)));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backlink_snapshot_targets','backlink_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f16_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f16_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.f16_snapshot_target_cap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_backlink_snapshots(date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_backlink_snapshots(date, integer) TO service_role;
