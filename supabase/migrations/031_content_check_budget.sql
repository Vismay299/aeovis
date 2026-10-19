-- One paid recheck per exact draft/dependency version; reservations coordinate
-- across server instances, and failed/ambiguous calls retain unknown spend.
CREATE TABLE IF NOT EXISTS content_check_claims (
 item_id uuid NOT NULL REFERENCES content_items(id),check_key text NOT NULL,brand text NOT NULL,
 content_version integer NOT NULL,token uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'leased' CHECK(state IN ('leased','complete','unknown')),
 reserved_usd numeric NOT NULL,charged_usd numeric,lease_until timestamptz NOT NULL DEFAULT now()+interval '120 seconds',
 result jsonb,PRIMARY KEY(item_id,check_key)
);
ALTER TABLE content_check_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON content_check_claims FROM PUBLIC,anon,authenticated;
GRANT ALL ON content_check_claims TO service_role;
CREATE OR REPLACE FUNCTION claim_content_check(p_item uuid,p_brand text,p_version integer,p_hash text,p_key text,p_reserve numeric,p_cap numeric)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item content_items; claim content_check_claims; measured numeric; held numeric;
BEGIN
 IF p_reserve IS NULL OR p_reserve<=0 OR p_cap IS NULL OR p_cap<=0 THEN RAISE EXCEPTION 'invalid check budget'; END IF;
 SELECT * INTO item FROM content_items WHERE id=p_item AND brand=p_brand FOR UPDATE;
 IF NOT FOUND OR item.content_version IS DISTINCT FROM p_version OR item.content_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'draft version conflict'; END IF;
 SELECT * INTO claim FROM content_check_claims WHERE item_id=p_item AND check_key=p_key;
 IF FOUND THEN RETURN jsonb_build_object('granted',false,'state',claim.state,'check',claim.result); END IF;
 SELECT coalesce(cost_total,0) INTO measured FROM content_jobs WHERE id=item.job_id FOR UPDATE;
 SELECT coalesce(sum(reserved_usd),0) INTO held FROM content_check_claims c JOIN content_items ci ON ci.id=c.item_id WHERE (ci.job_id=item.job_id OR ci.id=p_item) AND charged_usd IS NULL;
 IF coalesce(measured,0)+held+p_reserve>p_cap THEN RETURN jsonb_build_object('granted',false,'state','budget_exhausted'); END IF;
 INSERT INTO content_check_claims(item_id,check_key,brand,content_version,reserved_usd) VALUES(p_item,p_key,p_brand,p_version,p_reserve) RETURNING * INTO claim;
 RETURN jsonb_build_object('granted',true,'token',claim.token);
END $$;
CREATE OR REPLACE FUNCTION finish_content_check(p_item uuid,p_brand text,p_key text,p_token uuid,p_check jsonb,p_cost numeric)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item content_items; claim content_check_claims; applied boolean:=false;
BEGIN
 SELECT * INTO item FROM content_items WHERE id=p_item AND brand=p_brand FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'draft not found'; END IF;
 SELECT * INTO claim FROM content_check_claims WHERE item_id=p_item AND check_key=p_key FOR UPDATE;
 IF NOT FOUND OR claim.token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'invalid check token'; END IF;
 IF claim.state<>'leased' THEN RETURN jsonb_build_object('applied',false,'duplicate',true); END IF;
 IF claim.lease_until<clock_timestamp() OR p_check IS NULL THEN
  UPDATE content_check_claims SET state='unknown' WHERE item_id=p_item AND check_key=p_key;
  RETURN jsonb_build_object('applied',false,'state','unknown');
 END IF;
 IF p_cost IS NOT NULL AND p_cost<0 THEN RAISE EXCEPTION 'invalid check cost'; END IF;
 UPDATE content_check_claims SET state='complete',result=p_check,charged_usd=p_cost WHERE item_id=p_item AND check_key=p_key;
 IF item.job_id IS NOT NULL AND p_cost IS NOT NULL THEN UPDATE content_jobs SET cost_total=coalesce(cost_total,0)+p_cost WHERE id=item.job_id; END IF;
 IF item.content_version=claim.content_version AND p_check->>'content_hash'=item.content_hash AND p_check->'research_snapshot'=coalesce(item.research_pack,'{}'::jsonb) THEN
  UPDATE content_items SET rubric=coalesce(rubric,'{}'::jsonb)||jsonb_build_object('check',p_check),status='awaiting_approval',approved_hash=NULL WHERE id=p_item;
  applied:=true;
 END IF;
 RETURN jsonb_build_object('applied',applied,'check',p_check);
END $$;
REVOKE ALL ON FUNCTION claim_content_check(uuid,text,integer,text,text,numeric,numeric),finish_content_check(uuid,text,text,uuid,jsonb,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION claim_content_check(uuid,text,integer,text,text,numeric,numeric),finish_content_check(uuid,text,text,uuid,jsonb,numeric) TO service_role;
-- Guard every writer, including old operator code, from approving stale checks.
CREATE OR REPLACE FUNCTION require_checked_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE input_hash text;
BEGIN
 IF NEW.status='approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
  input_hash:=repair_content_hash(NEW.title,NEW.body_md);
  IF NEW.rubric->'check'->>'passed' IS DISTINCT FROM 'true' OR NEW.rubric->'check'->>'content_hash' IS DISTINCT FROM input_hash
    OR NEW.rubric->'check'->'research_snapshot' IS DISTINCT FROM coalesce(NEW.research_pack,'{}'::jsonb) THEN RAISE EXCEPTION 'current passing check required'; END IF;
  NEW.approved_hash:=input_hash;
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS require_checked_approval ON content_items;
CREATE TRIGGER require_checked_approval BEFORE UPDATE ON content_items FOR EACH ROW EXECUTE FUNCTION require_checked_approval();
NOTIFY pgrst,'reload schema';
