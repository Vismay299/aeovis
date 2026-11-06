-- F08: import existing panel/default versions into workspace_questions, once per workspace.
CREATE OR REPLACE FUNCTION public.backfill_workspace_questions(p_brand text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a repair_artifacts; head repair_artifacts; e jsonb; n integer; v_created integer := 0; v_active integer := 0; v_rev bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('f08:questions:' || p_brand));
  INSERT INTO workspace_question_settings(brand_key) VALUES (p_brand) ON CONFLICT DO NOTHING;
  IF (SELECT backfilled_at FROM workspace_question_settings WHERE brand_key = p_brand) IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', true); END IF;
  FOR a IN SELECT * FROM repair_artifacts WHERE brand = p_brand AND kind = 'panel' AND artifact_key = 'default' ORDER BY version LOOP
    FOR e IN SELECT value FROM jsonb_array_elements(coalesce(a.payload->'prompts', '[]'::jsonb)) LOOP
      CONTINUE WHEN length(btrim(coalesce(e->>'text', ''))) < 2;
      INSERT INTO workspace_questions(brand_key, text, topic, origin, status, branded, source_ref)
      VALUES (p_brand, btrim(regexp_replace(e->>'text', '\s+', ' ', 'g')), coalesce(nullif(btrim(e->>'topic'), ''), 'General'),
              'import', 'archived', coalesce(e->>'purpose', '') = 'diagnostic',
              jsonb_build_object('kind', 'panel_import', 'panel_origin', e->>'origin', 'first_version', a.version))
      ON CONFLICT (brand_key, text_normalized) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT; v_created := v_created + n;
    END LOOP;
  END LOOP;
  SELECT x.* INTO head FROM repair_artifact_heads h JOIN repair_artifacts x ON x.id = h.artifact_id
   WHERE h.brand = p_brand AND h.kind = 'panel' AND h.artifact_key = 'default' AND x.state IN ('draft','approved');
  IF head.id IS NOT NULL THEN
    UPDATE workspace_questions SET status = 'active'
     WHERE brand_key = p_brand AND text_normalized IN
       (SELECT normalize_question_text(x->>'text') FROM jsonb_array_elements(coalesce(head.payload->'prompts','[]'::jsonb)) x);
    GET DIAGNOSTICS v_active = ROW_COUNT;
    UPDATE workspace_question_settings SET persona = nullif(btrim(head.payload->>'persona'), ''),
      country = CASE WHEN lower(head.payload->'context'->>'country') ~ '^[a-z]{2}$' THEN lower(head.payload->'context'->>'country') ELSE country END,
      language = CASE WHEN lower(head.payload->'context'->>'language') ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$' THEN lower(head.payload->'context'->>'language') ELSE language END
     WHERE brand_key = p_brand;
  END IF;
  UPDATE workspace_question_settings SET backfilled_at = now() WHERE brand_key = p_brand;
  v_rev := f08_bump_revision(p_brand, NULL);
  RETURN jsonb_build_object('created', v_created, 'active', v_active, 'headVersion', head.version, 'revision', v_rev);
END $$;
REVOKE ALL ON FUNCTION public.backfill_workspace_questions(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_workspace_questions(text) TO service_role;
NOTIFY pgrst, 'reload schema';
