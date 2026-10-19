-- Immutable reviewed panels/source opportunities and exact-version content gates.
CREATE TABLE IF NOT EXISTS repair_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL,kind text NOT NULL,
 artifact_key text NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL,
 payload jsonb NOT NULL,sha256 text NOT NULL,actor uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(brand,kind,artifact_key,version),
 CHECK(kind IN ('panel','source_snapshot','opportunity','publication','comparison','calibration','collector_qualification','study','technical_audit'))
);
ALTER TABLE repair_artifacts DROP CONSTRAINT IF EXISTS repair_artifacts_kind_check;
ALTER TABLE repair_artifacts ADD CONSTRAINT repair_artifacts_kind_check CHECK(kind IN ('panel','source_snapshot','opportunity','publication','comparison','calibration','collector_qualification','study','technical_audit'));
CREATE TABLE IF NOT EXISTS repair_artifact_heads (
 brand text NOT NULL,kind text NOT NULL,artifact_key text NOT NULL,version integer NOT NULL DEFAULT 0,
 artifact_id uuid REFERENCES repair_artifacts(id),PRIMARY KEY(brand,kind,artifact_key)
);
ALTER TABLE repair_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_artifact_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON repair_artifacts,repair_artifact_heads FROM PUBLIC,anon,authenticated;
GRANT SELECT ON repair_artifacts,repair_artifact_heads TO authenticated;
GRANT SELECT,INSERT ON repair_artifacts TO service_role;
GRANT ALL ON repair_artifact_heads TO service_role;
DROP POLICY IF EXISTS repair_artifacts_customer_read ON repair_artifacts;
CREATE POLICY repair_artifacts_customer_read ON repair_artifacts FOR SELECT TO authenticated USING(customer_can_access_brand(brand));
DROP POLICY IF EXISTS repair_heads_customer_read ON repair_artifact_heads;
CREATE POLICY repair_heads_customer_read ON repair_artifact_heads FOR SELECT TO authenticated USING(customer_can_access_brand(brand));
CREATE OR REPLACE FUNCTION append_repair_artifact(p_brand text,p_kind text,p_key text,p_expected integer,p_state text,p_payload jsonb,p_hash text,p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE h repair_artifact_heads; a repair_artifacts;
BEGIN
 IF p_expected<0 OR length(p_key)>200 OR jsonb_typeof(p_payload)<>'object' OR length(p_hash)<>64 THEN RAISE EXCEPTION 'invalid artifact'; END IF;
 IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_brand_memberships WHERE brand_key=p_brand AND user_id=p_actor) THEN
   RAISE EXCEPTION 'workspace not found'; END IF;
 INSERT INTO repair_artifact_heads(brand,kind,artifact_key) VALUES(p_brand,p_kind,p_key) ON CONFLICT DO NOTHING;
 SELECT * INTO h FROM repair_artifact_heads WHERE brand=p_brand AND kind=p_kind AND artifact_key=p_key FOR UPDATE;
 IF h.version<>p_expected THEN RAISE EXCEPTION 'artifact revision conflict'; END IF;
 IF p_kind='panel' AND p_state='approved' AND (p_actor IS NULL OR NOT p_payload ? 'prompts') THEN RAISE EXCEPTION 'reviewed panel requires reviewer and prompts'; END IF;
 INSERT INTO repair_artifacts(brand,kind,artifact_key,version,state,payload,sha256,actor)
 VALUES(p_brand,p_kind,p_key,p_expected+1,p_state,p_payload,p_hash,p_actor) RETURNING * INTO a;
 UPDATE repair_artifact_heads SET version=a.version,artifact_id=a.id WHERE brand=p_brand AND kind=p_kind AND artifact_key=p_key;
 RETURN to_jsonb(a);
END $$;
REVOKE ALL ON FUNCTION append_repair_artifact(text,text,text,integer,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION append_repair_artifact(text,text,text,integer,text,jsonb,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION repair_content_hash(p_title text,p_body text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(coalesce(p_title,'')||E'\n\n'||coalesce(p_body,''),'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION repair_content_hash(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION repair_content_hash(text,text) TO service_role;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS approved_hash text;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS content_hash text GENERATED ALWAYS AS
 (repair_content_hash(title,body_md)) STORED;
CREATE OR REPLACE FUNCTION invalidate_changed_content() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.title IS DISTINCT FROM OLD.title OR NEW.body_md IS DISTINCT FROM OLD.body_md OR NEW.research_pack IS DISTINCT FROM OLD.research_pack THEN
   NEW.content_version:=OLD.content_version+1;NEW.approved_hash:=NULL;
   IF NEW.rubric->'check'->>'content_hash' IS DISTINCT FROM encode(sha256(convert_to(coalesce(NEW.title,'')||E'\n\n'||coalesce(NEW.body_md,''),'UTF8')),'hex')
     OR NEW.rubric->'check'->'research_snapshot' IS DISTINCT FROM coalesce(NEW.research_pack,'{}'::jsonb) THEN
     NEW.rubric:=coalesce(NEW.rubric,'{}'::jsonb)-'check';
   END IF;
   IF OLD.status IN ('approved','published') THEN NEW.status:='awaiting_approval'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_exact_version ON content_items;
CREATE TRIGGER content_exact_version BEFORE UPDATE ON content_items FOR EACH ROW EXECUTE FUNCTION invalidate_changed_content();
CREATE OR REPLACE FUNCTION decide_checked_content(p_item uuid,p_brand text,p_version integer,p_hash text,p_status text,p_comment text,p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item content_items;
BEGIN
 SELECT * INTO item FROM content_items WHERE id=p_item AND brand=p_brand FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'draft not found'; END IF;
 IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_brand_memberships WHERE brand_key=p_brand AND user_id=p_actor) THEN RAISE EXCEPTION 'draft not found'; END IF;
 IF p_version IS DISTINCT FROM item.content_version OR p_hash IS DISTINCT FROM item.content_hash OR item.status NOT IN ('awaiting_approval','rejected') THEN RAISE EXCEPTION 'stale draft version'; END IF;
 IF p_status NOT IN ('approved','rejected','changes_requested') THEN RAISE EXCEPTION 'invalid editorial decision'; END IF;
 IF p_status='approved' AND (item.rubric->'check'->>'content_hash' IS DISTINCT FROM item.content_hash
   OR item.rubric->'check'->'research_snapshot' IS DISTINCT FROM coalesce(item.research_pack,'{}'::jsonb)
   OR item.rubric->'check'->>'passed' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'current draft requires a passing evidence check'; END IF;
 INSERT INTO content_feedback(item_id,brand,verdict,comment) VALUES(item.id,item.brand,p_status,p_comment);
 UPDATE content_items SET status=p_status,approved_hash=CASE WHEN p_status='approved' THEN item.content_hash ELSE NULL END WHERE id=item.id;
 IF item.job_id IS NOT NULL THEN UPDATE content_jobs SET status=CASE WHEN p_status='changes_requested' THEN 'awaiting_approval' ELSE p_status END WHERE id=item.job_id; END IF;
 RETURN jsonb_build_object('id',item.id,'status',p_status,'content_hash',item.content_hash,'content_version',item.content_version,'published',false);
END $$;
REVOKE ALL ON FUNCTION decide_checked_content(uuid,text,integer,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION decide_checked_content(uuid,text,integer,text,text,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION record_verified_publication(p_item uuid,p_brand text,p_version integer,p_hash text,p_url text,p_verification jsonb,p_key text,p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item content_items; existing repair_artifacts; publication jsonb; event_id uuid; data jsonb;
BEGIN
 SELECT * INTO item FROM content_items WHERE id=p_item AND brand=p_brand FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'draft not found'; END IF;
 IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM customer_brand_memberships WHERE brand_key=p_brand AND user_id=p_actor) THEN RAISE EXCEPTION 'draft not found'; END IF;
 SELECT a.* INTO existing FROM repair_artifact_heads h JOIN repair_artifacts a ON a.id=h.artifact_id WHERE h.brand=p_brand AND h.kind='publication' AND h.artifact_key=p_key;
 IF FOUND THEN
   IF existing.payload->>'content_version' IS DISTINCT FROM p_version::text OR existing.payload->>'item_id'<>p_item::text OR existing.payload->>'content_hash'<>p_hash OR existing.payload->>'url'<>p_url THEN RAISE EXCEPTION 'publication idempotency conflict'; END IF;
   RETURN existing.payload;
 END IF;
 IF p_version IS DISTINCT FROM item.content_version OR p_hash IS DISTINCT FROM item.content_hash OR item.approved_hash IS DISTINCT FROM p_hash
   OR item.status<>'approved' OR item.rubric->'check'->>'passed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'exact checked and approved draft required'; END IF;
 IF p_verification->>'matched' IS DISTINCT FROM 'true' OR p_verification->>'content_hash' IS DISTINCT FROM p_hash OR p_verification->>'status' IS DISTINCT FROM '200' THEN RAISE EXCEPTION 'verified body match required'; END IF;
 INSERT INTO content_events(brand,url,publish_date) VALUES(item.brand,p_url,now()) ON CONFLICT(brand,url) DO UPDATE SET url=excluded.url RETURNING id INTO event_id;
 data:=jsonb_build_object('item_id',item.id,'content_hash',item.content_hash,'content_version',item.content_version,
  'url',p_url,'event_id',event_id,'verification',p_verification,'published_at',clock_timestamp(),'target_queries',item.target_queries,
  'indexing',NULL,'verified_crawl',NULL,'observed_citation',NULL);
 publication:=append_repair_artifact(item.brand,'publication',p_key,0,'published',data,p_hash,p_actor);
 UPDATE content_items SET status='published' WHERE id=item.id;
 IF item.job_id IS NOT NULL THEN UPDATE content_jobs SET status='published' WHERE id=item.job_id; END IF;
 RETURN data;
END $$;
REVOKE ALL ON FUNCTION record_verified_publication(uuid,text,integer,text,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION record_verified_publication(uuid,text,integer,text,text,jsonb,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
