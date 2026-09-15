-- 019: Storage bucket `probe-evidence` — PNG screenshots + gzipped HTML per probe.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R1.5.1.
-- Budget and retention: docs/runbooks/probe-evidence.md.
-- Retention is enforced by cron /api/evidence/retention (src/lib/evidenceRetention.js).
-- Safe to re-run.
--
-- ADDITIVE: one storage bucket and three storage.objects policies scoped to it.
--
-- WHY RETENTION IS NOT SQL: Supabase's `protect_objects_delete` trigger refuses
-- DELETE on storage.objects from SQL (a row deleted that way would orphan the
-- file in the object store). Objects must be removed through the Storage API,
-- so the 90-day policy lives in the app's daily cron, not in pg_cron.
--
-- PRIVATE: evidence is read through signed URLs (R1.5.3), never a public URL.
-- The Next app holds only the anon key (house rule since 001), so the policies
-- grant anon insert/select/delete on THIS bucket only — the same exposure every
-- table in this schema already has, scoped rather than widened.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'probe-evidence',
  'probe-evidence',
  false,
  5242880,                                             -- 5 MiB per object
  ARRAY['image/png', 'application/gzip', 'text/html']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'probe-evidence anon insert') THEN
    CREATE POLICY "probe-evidence anon insert" ON storage.objects
      FOR INSERT TO anon WITH CHECK (bucket_id = 'probe-evidence');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'probe-evidence anon select') THEN
    CREATE POLICY "probe-evidence anon select" ON storage.objects
      FOR SELECT TO anon USING (bucket_id = 'probe-evidence');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'probe-evidence anon delete') THEN
    CREATE POLICY "probe-evidence anon delete" ON storage.objects
      FOR DELETE TO anon USING (bucket_id = 'probe-evidence');
  END IF;
END $$;
