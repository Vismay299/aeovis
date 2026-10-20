-- Response snapshots use application/json; retain the existing screenshot/HTML formats.
UPDATE storage.buckets SET public=false,
  allowed_mime_types=ARRAY['image/png','application/gzip','text/html','application/json']
WHERE id='probe-evidence';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='probe-evidence' AND NOT public
   AND 'application/json'=ANY(allowed_mime_types)) THEN
   RAISE EXCEPTION 'private probe-evidence bucket with JSON capture support required';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION measurement_storage_ready() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM storage.buckets WHERE id='probe-evidence' AND NOT public
   AND 'application/json'=ANY(allowed_mime_types));
$$;
REVOKE ALL ON FUNCTION measurement_storage_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION measurement_storage_ready() TO service_role;
NOTIFY pgrst,'reload schema';
