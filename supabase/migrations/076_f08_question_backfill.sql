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

-- Appends an approved legacy panel and syncs stable question IDs as one transaction.
CREATE OR REPLACE FUNCTION public.append_approved_panel_with_questions(
  p_brand text, p_key text, p_expected integer, p_canonical_payload text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_payload json;
  v_sync jsonb;
  v_prompts text;
  v_payload_text text;
  v_hash text;
  v_artifact jsonb;
BEGIN
  IF p_canonical_payload IS NULL OR length(p_canonical_payload) > 500000 THEN
    RAISE EXCEPTION 'invalid artifact';
  END IF;
  BEGIN
    v_payload := p_canonical_payload::json;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid artifact';
  END;
  IF json_typeof(v_payload) <> 'object' OR json_typeof(v_payload->'prompts') <> 'array'
     OR json_array_length(v_payload->'prompts') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'reviewed panel requires reviewer and prompts';
  END IF;

  -- Any later error, including append_repair_artifact's version conflict,
  -- rolls back this backfill and sync because the whole operation is one RPC.
  PERFORM public.backfill_workspace_questions(p_brand);
  v_sync := public.sync_panel_questions(
    p_brand,
    (v_payload::jsonb)->'prompts',
    jsonb_build_object(
      'persona', v_payload->>'persona',
      'country', v_payload->'context'->>'country',
      'language', v_payload->'context'->>'language'
    ),
    p_actor
  );
  IF jsonb_array_length(v_sync->'ids') <> json_array_length(v_payload->'prompts') THEN
    RAISE EXCEPTION 'panel question identity mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM json_array_elements(v_payload->'prompts') AS p(prompt)
     WHERE json_typeof(p.prompt) <> 'object'
        OR NOT (p.prompt::jsonb ? 'id')
        OR NOT (p.prompt::jsonb ? 'question_id')
  ) THEN
    RAISE EXCEPTION 'invalid artifact';
  END IF;

  -- The application sent canonical JSON so the stored sha256 remains identical
  -- to artifactHash(payload). json (rather than jsonb) preserves number spelling
  -- and object-key order while we replace only the two question ID fields.
  SELECT '[' || string_agg(rewritten.json_text, ',' ORDER BY source.ordinality) || ']'
    INTO v_prompts
    FROM json_array_elements(v_payload->'prompts') WITH ORDINALITY AS source(prompt, ordinality)
    CROSS JOIN LATERAL (
      SELECT '{' || string_agg(
        to_json(f.key)::text || ':' ||
          CASE f.key
            WHEN 'id' THEN to_json(v_sync->'ids'->((source.ordinality - 1)::integer)->>'question_id')::text
            WHEN 'question_id' THEN to_json(v_sync->'ids'->((source.ordinality - 1)::integer)->>'question_id')::text
            ELSE f.value::text
          END,
        ',' ORDER BY f.ordinality
      ) || '}' AS json_text
      FROM json_each(source.prompt) WITH ORDINALITY AS f(key, value, ordinality)
    ) AS rewritten;

  SELECT '{' || string_agg(
    to_json(field.key)::text || ':' ||
      CASE WHEN field.key = 'prompts' THEN v_prompts ELSE field.value::text END,
    ',' ORDER BY field.ordinality
  ) || '}'
    INTO v_payload_text
    FROM json_each(v_payload) WITH ORDINALITY AS field(key, value, ordinality);

  v_hash := encode(sha256(convert_to(v_payload_text, 'UTF8')), 'hex');
  v_artifact := public.append_repair_artifact(
    p_brand, 'panel', p_key, p_expected, 'approved', v_payload_text::jsonb, v_hash, p_actor
  );
  RETURN v_artifact;
END $$;
REVOKE ALL ON FUNCTION public.append_approved_panel_with_questions(text,text,integer,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_approved_panel_with_questions(text,text,integer,text,uuid)
  TO service_role;
NOTIFY pgrst, 'reload schema';
