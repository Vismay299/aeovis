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
  deleted_at   timestamptz
);
-- Constraints are added separately so the migration-ledger guard can verify
-- each name (it reads ALTER TABLE ... ADD CONSTRAINT, not inline clauses) and
-- so a re-run is safe: PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.
ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_kind_ck;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_kind_ck CHECK (kind ~ '^[a-z][a-z0-9_]{2,40}$');
ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_format_ck;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_format_ck CHECK (format IN ('csv', 'json'));
ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_status_ck;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_status_ck CHECK (status IN ('pending', 'ready', 'failed', 'deleted'));
ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_counts_ck;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_counts_ck CHECK ((row_count IS NULL OR row_count >= 0) AND (byte_size IS NULL OR byte_size >= 0));
ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_path_ck;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_path_ck CHECK (storage_path IS NULL OR storage_path LIKE brand_key || '/%');
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
