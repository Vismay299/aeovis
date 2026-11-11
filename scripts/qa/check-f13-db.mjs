#!/usr/bin/env node
// F13 database harness: migrations 100, 101, 102
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

if (
  !["127.0.0.1", "localhost", "::1"].includes(process.env.PGHOST) ||
  !/(?:_qa|_uat)$/.test(process.env.PGDATABASE || "") ||
  process.env.DATABASE_URL
) {
  throw Error("Explicit loopback QA database required; DATABASE_URL refused");
}

const pool = new pg.Pool({ max: 4 });
const passed = [];
const groupFlagIdx = process.argv.indexOf("--group");
const targetGroup = groupFlagIdx !== -1 ? process.argv[groupFlagIdx + 1] : null;
const id = () => randomUUID();

async function group(name, fn) {
  if (targetGroup && targetGroup !== name) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("ROLLBACK");
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* keep original failure */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function rpc(client, name, values) {
  const entries = Object.entries(values);
  const r = await client.query(
    `SELECT ${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) AS result`,
    entries.map(([, v]) => (v && typeof v === "object" ? JSON.stringify(v) : v))
  );
  return r.rows[0].result;
}

async function makeBrand(client, suffix) {
  const brandKey = `qa-f13-${suffix}-${id()}.example`;
  await client.query(
    "INSERT INTO public.customer_brands(brand_key,display_name,website,website_host,aliases) VALUES($1,$2,$3,$4,$5)",
    [brandKey, `F13 ${suffix}`, `https://${brandKey}`, brandKey, []]
  );
  return brandKey;
}

async function makeUser(client, suffix) {
  const userId = id();
  await client.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
    [userId, `${userId}@${suffix}.f13.test`]
  );
  return userId;
}

try {
  // 1. schema
  await group("schema", async (client) => {
    // Check tables exist
    for (const t of ["saved_keywords", "saved_keyword_tags", "saved_keyword_tag_assignments", "keyword_metrics"]) {
      const { rows } = await client.query("SELECT to_regclass($1) as reg", [`public.${t}`]);
      assert.ok(rows[0].reg, `table public.${t} exists`);
    }

    // Check functions exist in pg_proc
    const expectedFunctions = [
      "f13_like_escape",
      "f13_upsert_tags",
      "save_keywords",
      "f13_filtered_saved_keywords",
      "list_saved_keywords",
      "update_saved_keyword_tags",
      "delete_saved_keyword_tag",
      "remove_saved_keywords",
      "upsert_keyword_metrics",
      "prune_keyword_metrics",
    ];
    for (const fn of expectedFunctions) {
      const { rows } = await client.query("SELECT count(*) as count FROM pg_proc WHERE proname = $1", [fn]);
      assert.ok(Number(rows[0].count) > 0, `function ${fn} exists`);
    }

    // Check grants: authenticated has SELECT on saved_* tables, but not on keyword_metrics
    await client.query("SET LOCAL ROLE authenticated");
    for (const t of ["saved_keywords", "saved_keyword_tags", "saved_keyword_tag_assignments"]) {
      await client.query(`SELECT count(*) FROM public.${t}`);
    }

    let deniedMetrics = false;
    await client.query("SAVEPOINT denied_m");
    try {
      await client.query("SELECT * FROM public.keyword_metrics LIMIT 1");
    } catch (e) {
      if (e.code === "42501") deniedMetrics = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT denied_m");
    assert.equal(deniedMetrics, true, "authenticated denied SELECT on keyword_metrics");

    // Authenticated cannot EXECUTE save_keywords
    let deniedExecute = false;
    await client.query("SAVEPOINT denied_exec");
    try {
      await client.query("SELECT public.save_keywords('brand', ARRAY['kw'], 2356, 'en')");
    } catch (e) {
      if (e.code === "42501") deniedExecute = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT denied_exec");
    assert.equal(deniedExecute, true, "authenticated denied EXECUTE on save_keywords");

    await client.query("RESET ROLE");
  });

  // 2. rls
  await group("rls", async (client) => {
    const brandA = await makeBrand(client, "rls-a");
    const brandB = await makeBrand(client, "rls-b");
    const userA = await makeUser(client, "rls-a");
    const userB = await makeUser(client, "rls-b");

    await client.query(
      "INSERT INTO public.customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
      [userA, brandA, userB, brandB]
    );

    const kwIdA = id();
    const kwIdB = id();
    const tagIdA = id();
    const tagIdB = id();

    await client.query(
      "INSERT INTO public.saved_keywords(id,brand_key,keyword,location_code,language_code) VALUES ($1,$2,'kw-a',2356,'en'), ($3,$4,'kw-b',2356,'en')",
      [kwIdA, brandA, kwIdB, brandB]
    );
    await client.query(
      "INSERT INTO public.saved_keyword_tags(id,brand_key,name,normalized_name) VALUES ($1,$2,'Tag A','tag a'), ($3,$4,'Tag B','tag b')",
      [tagIdA, brandA, tagIdB, brandB]
    );
    await client.query(
      "INSERT INTO public.saved_keyword_tag_assignments(brand_key,saved_keyword_id,tag_id) VALUES ($1,$2,$3), ($4,$5,$6)",
      [brandA, kwIdA, tagIdA, brandB, kwIdB, tagIdB]
    );

    // Cross-workspace tag assignment must be refused by composite FK
    let fkViolation = false;
    await client.query("SAVEPOINT cross_assign");
    try {
      await client.query(
        "INSERT INTO public.saved_keyword_tag_assignments(brand_key,saved_keyword_id,tag_id) VALUES ($1,$2,$3)",
        [brandA, kwIdA, tagIdB]
      );
    } catch (err) {
      if (err.code === "23503") fkViolation = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT cross_assign");
    assert.equal(fkViolation, true, "cross-workspace tag assignment raises FK violation");

    // Authenticated user A should only see brand A rows
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userA]);

    const { rows: kws } = await client.query("SELECT * FROM public.saved_keywords");
    assert.equal(kws.length, 1);
    assert.equal(kws[0].brand_key, brandA);

    const { rows: tags } = await client.query("SELECT * FROM public.saved_keyword_tags");
    assert.equal(tags.length, 1);
    assert.equal(tags[0].brand_key, brandA);

    const { rows: assigns } = await client.query("SELECT * FROM public.saved_keyword_tag_assignments");
    assert.equal(assigns.length, 1);
    assert.equal(assigns[0].brand_key, brandA);

    // keyword_metrics is denied for authenticated
    let denied = false;
    await client.query("SAVEPOINT denied_m");
    try {
      await client.query("SELECT * FROM public.keyword_metrics");
    } catch (e) {
      if (e.code === "42501") denied = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT denied_m");
    assert.equal(denied, true, "authenticated denied on keyword_metrics");

    await client.query("RESET ROLE");
  });

  // 3. caps
  await group("caps", async (client) => {
    const brand = await makeBrand(client, "caps");

    // Tag cap: 200 tags allowed, 201st rolls back
    const tagRows = [];
    for (let i = 1; i <= 200; i++) {
      tagRows.push({ name: `Tag ${i}`, normalized: `tag ${i}` });
    }
    // Upsert 200 tags in chunks
    await rpc(client, "f13_upsert_tags", { p_brand: brand, p_tags: tagRows.slice(0, 50) });
    await rpc(client, "f13_upsert_tags", { p_brand: brand, p_tags: tagRows.slice(50, 100) });
    await rpc(client, "f13_upsert_tags", { p_brand: brand, p_tags: tagRows.slice(100, 150) });
    await rpc(client, "f13_upsert_tags", { p_brand: brand, p_tags: tagRows.slice(150, 200) });

    let tagCapError = false;
    await client.query("SAVEPOINT tag_cap");
    try {
      await rpc(client, "f13_upsert_tags", { p_brand: brand, p_tags: [{ name: "Tag 201", normalized: "tag 201" }] });
    } catch (err) {
      if (err.message.includes("saved_keywords_cap:tags")) tagCapError = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT tag_cap");
    assert.equal(tagCapError, true, "201st tag rolls back with saved_keywords_cap:tags");

    // Keyword cap: 5,000 allowed, 5,001st rolls back
    // Direct insert 5,000 keywords
    await client.query(
      `INSERT INTO public.saved_keywords(brand_key, keyword, location_code, language_code)
       SELECT $1, 'kw-' || g, 2356, 'en' FROM generate_series(1, 5000) g`,
      [brand]
    );

    let kwCapError = false;
    await client.query("SAVEPOINT kw_cap");
    try {
      await rpc(client, "save_keywords", {
        p_brand: brand,
        p_keywords: ["kw-5001"],
        p_location: 2356,
        p_language: "en",
      });
    } catch (err) {
      if (err.message.includes("saved_keywords_cap:keywords")) kwCapError = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT kw_cap");
    assert.equal(kwCapError, true, "5,001st keyword rolls back with saved_keywords_cap:keywords");
  });

  // 4. save
  await group("save", async (client) => {
    const brand = await makeBrand(client, "save");
    const user = await makeUser(client, "save");

    // Append mode with tags
    const res1 = await rpc(client, "save_keywords", {
      p_brand: brand,
      p_keywords: ["running shoes", "trail shoes"],
      p_location: 2356,
      p_language: "en",
      p_tags: [{ name: "Shoes", normalized: "shoes" }],
      p_tag_mode: "append",
      p_actor: user,
    });
    assert.equal(res1.created, 2, "created 2 keywords");
    assert.equal(res1.savedKeywordIds.length, 2, "returned 2 ids");

    // Idempotent: repeated save returns existing ids with created = 0
    const res2 = await rpc(client, "save_keywords", {
      p_brand: brand,
      p_keywords: ["running shoes"],
      p_location: 2356,
      p_language: "en",
      p_tags: [{ name: "Running", normalized: "running" }],
      p_tag_mode: "append",
      p_actor: user,
    });
    assert.equal(res2.created, 0, "created 0 repeated keywords");
    assert.equal(res2.savedKeywordIds.length, 1);
    assert.equal(res2.savedKeywordIds[0], res1.savedKeywordIds[0]);

    // Check tags appended (should now have both Shoes and Running)
    const { rows: assigns } = await client.query(
      `SELECT t.name FROM saved_keyword_tag_assignments a
       JOIN saved_keyword_tags t ON t.id = a.tag_id
       WHERE a.saved_keyword_id = $1 ORDER BY t.name`,
      [res1.savedKeywordIds[0]]
    );
    assert.deepEqual(assigns.map(r => r.name), ["Running", "Shoes"]);

    // Replace mode requires tags
    let replaceError = false;
    await client.query("SAVEPOINT replace_err");
    try {
      await rpc(client, "save_keywords", {
        p_brand: brand,
        p_keywords: ["running shoes"],
        p_location: 2356,
        p_language: "en",
        p_tags: [],
        p_tag_mode: "replace",
      });
    } catch (err) {
      if (err.message.includes("saved_keywords_invalid:replace_requires_tags")) replaceError = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT replace_err");
    assert.equal(replaceError, true, "replace mode requires tags");

    // Replace mode with tags removes old assignments and sets new ones
    await rpc(client, "save_keywords", {
      p_brand: brand,
      p_keywords: ["running shoes"],
      p_location: 2356,
      p_language: "en",
      p_tags: [{ name: "Gear", normalized: "gear" }],
      p_tag_mode: "replace",
    });
    const { rows: assignsAfter } = await client.query(
      `SELECT t.name FROM saved_keyword_tag_assignments a
       JOIN saved_keyword_tags t ON t.id = a.tag_id
       WHERE a.saved_keyword_id = $1 ORDER BY t.name`,
      [res1.savedKeywordIds[0]]
    );
    assert.deepEqual(assignsAfter.map(r => r.name), ["Gear"]);
  });

  // 5. list
  await group("list", async (client) => {
    const brand = await makeBrand(client, "list");
    const loc = 2356;
    const lang = "en";

    // Insert metrics into keyword_metrics
    await rpc(client, "upsert_keyword_metrics", {
      p_rows: [
        {
          keyword: "oversized t shirt",
          location_code: loc,
          language_code: lang,
          search_volume: 74000,
          cpc: 0.41,
          competition: 0.85,
          keyword_difficulty: 38,
          intent: "transactional",
          monthly_searches: [],
          source: "labs",
        },
        {
          keyword: "cotton t shirt",
          location_code: loc,
          language_code: lang,
          search_volume: 12000,
          cpc: 0.25,
          competition: 0.45,
          keyword_difficulty: 20,
          intent: "commercial",
          monthly_searches: [],
          source: "labs",
        },
      ],
    });

    // Save keywords
    const saveRes = await rpc(client, "save_keywords", {
      p_brand: brand,
      p_keywords: ["oversized t shirt", "cotton t shirt", "vintage hoodie"],
      p_location: loc,
      p_language: lang,
      p_tags: [{ name: "Tees", normalized: "tees" }],
    });
    assert.equal(saveRes.savedKeywordIds.length, 3);

    // Filter by search
    const listSearch = await rpc(client, "list_saved_keywords", {
      p_brand: brand,
      p_filters: { search: "oversized" },
    });
    assert.equal(listSearch.totalCount, 1);
    assert.equal(listSearch.rows[0].keyword, "oversized t shirt");
    assert.equal(listSearch.rows[0].searchVolume, 74000);
    assert.equal(Number(listSearch.rows[0].cpc), 0.41);
    assert.equal(listSearch.rows[0].tags.length, 1);
    assert.equal(listSearch.rows[0].tags[0].name, "Tees");

    // Include / exclude terms
    const listTerms = await rpc(client, "list_saved_keywords", {
      p_brand: brand,
      p_filters: { includeTerms: ["shirt"], excludeTerms: ["cotton"] },
    });
    assert.equal(listTerms.totalCount, 1);
    assert.equal(listTerms.rows[0].keyword, "oversized t shirt");

    // Volume range
    const listVol = await rpc(client, "list_saved_keywords", {
      p_brand: brand,
      p_filters: { minVolume: 10000, maxVolume: 50000 },
    });
    assert.equal(listVol.totalCount, 1);
    assert.equal(listVol.rows[0].keyword, "cotton t shirt");

    // Sorting: unknown/null metrics appear last in both directions
    const listSortAsc = await rpc(client, "list_saved_keywords", {
      p_brand: brand,
      p_sort: "searchVolume",
      p_order: "asc",
    });
    assert.equal(listSortAsc.rows[0].keyword, "cotton t shirt"); // 12000
    assert.equal(listSortAsc.rows[1].keyword, "oversized t shirt"); // 74000
    assert.equal(listSortAsc.rows[2].keyword, "vintage hoodie"); // null, last!

    const listSortDesc = await rpc(client, "list_saved_keywords", {
      p_brand: brand,
      p_sort: "searchVolume",
      p_order: "desc",
    });
    assert.equal(listSortDesc.rows[0].keyword, "oversized t shirt"); // 74000
    assert.equal(listSortDesc.rows[1].keyword, "cotton t shirt"); // 12000
    assert.equal(listSortDesc.rows[2].keyword, "vintage hoodie"); // null, last!

    // Tag counts returned
    assert.equal(listSortDesc.tags.length, 1);
    assert.equal(listSortDesc.tags[0].name, "Tees");
    assert.equal(listSortDesc.tags[0].keywordCount, 3);
  });

  // 6. tags
  await group("tags", async (client) => {
    const brand = await makeBrand(client, "tags");
    const saveRes = await rpc(client, "save_keywords", {
      p_brand: brand,
      p_keywords: ["kw-1", "kw-2"],
      p_location: 2356,
      p_language: "en",
    });
    const ids = saveRes.savedKeywordIds;

    // Add tags via update_saved_keyword_tags
    const updateRes = await rpc(client, "update_saved_keyword_tags", {
      p_brand: brand,
      p_ids: ids,
      p_add: [{ name: "Summer", normalized: "summer" }, { name: "Sale", normalized: "sale" }],
    });
    assert.equal(updateRes.taggedCount, 2);
    assert.equal(updateRes.addedTags.length, 2);

    const summerTagId = updateRes.addedTags.find(t => t.name === "Summer").id;
    const saleTagId = updateRes.addedTags.find(t => t.name === "Sale").id;

    // Delete tag while in use returns status in_use
    const delInUse = await rpc(client, "delete_saved_keyword_tag", {
      p_brand: brand,
      p_tag: summerTagId,
    });
    assert.equal(delInUse.status, "in_use");
    assert.equal(delInUse.assignmentCount, 2);

    // Remove summer tag from keywords
    const removeRes = await rpc(client, "update_saved_keyword_tags", {
      p_brand: brand,
      p_ids: ids,
      p_remove: [summerTagId],
    });
    assert.equal(removeRes.removedAssignments, 2);

    // Now delete summer tag returns status deleted
    const delSuccess = await rpc(client, "delete_saved_keyword_tag", {
      p_brand: brand,
      p_tag: summerTagId,
    });
    assert.equal(delSuccess.status, "deleted");

    // Deleting nonexistent tag returns status not_found
    const delNotFound = await rpc(client, "delete_saved_keyword_tag", {
      p_brand: brand,
      p_tag: id(),
    });
    assert.equal(delNotFound.status, "not_found");

    // Tag rename clash: unique constraint on (brand_key, normalized_name)
    await client.query(
      "INSERT INTO public.saved_keyword_tags(id,brand_key,name,normalized_name) VALUES ($1,$2,'Discount','discount')",
      [id(), brand]
    );
    let renameClash = false;
    await client.query("SAVEPOINT rename_clash");
    try {
      await client.query(
        "UPDATE public.saved_keyword_tags SET normalized_name = 'sale', name = 'Sale 2' WHERE id = (SELECT id FROM public.saved_keyword_tags WHERE brand_key = $1 AND normalized_name = 'discount')",
        [brand]
      );
    } catch (err) {
      if (err.code === "23505") renameClash = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT rename_clash");
    assert.equal(renameClash, true, "rename clash triggers 23505 unique violation");
  });

  // 7. remove
  await group("remove", async (client) => {
    const brandA = await makeBrand(client, "rm-a");
    const brandB = await makeBrand(client, "rm-b");

    const saveA = await rpc(client, "save_keywords", {
      p_brand: brandA,
      p_keywords: ["kw-a1", "kw-a2"],
      p_location: 2356,
      p_language: "en",
    });
    const saveB = await rpc(client, "save_keywords", {
      p_brand: brandB,
      p_keywords: ["kw-b1"],
      p_location: 2356,
      p_language: "en",
    });

    // Calling remove with mixed IDs: only brand A's rows are deleted
    const deletedCount = await rpc(client, "remove_saved_keywords", {
      p_brand: brandA,
      p_ids: [saveA.savedKeywordIds[0], saveB.savedKeywordIds[0]],
    });
    assert.equal(deletedCount, 1, "deleted only the caller's row");

    const { rows: leftA } = await client.query("SELECT * FROM public.saved_keywords WHERE brand_key = $1", [brandA]);
    assert.equal(leftA.length, 1);
    assert.equal(leftA[0].id, saveA.savedKeywordIds[1]);

    const { rows: leftB } = await client.query("SELECT * FROM public.saved_keywords WHERE brand_key = $1", [brandB]);
    assert.equal(leftB.length, 1, "other brand's row was untouched");
  });

  // 8. metrics (from P2)
  await group("metrics", async (client) => {
    const kw = `qa-kw-${id().slice(0, 8)}`;
    const location = 2356;
    const lang = "en";

    // 1. Initial upsert from 'labs'
    const initialRows = [
      {
        keyword: kw,
        location_code: location,
        language_code: lang,
        search_volume: 1000,
        cpc: 1.25,
        competition: 0.5,
        keyword_difficulty: 40,
        intent: "commercial",
        monthly_searches: [{ year: 2026, month: 9, search_volume: 1000 }],
        source: "labs",
      },
    ];
    const initialCount = await rpc(client, "upsert_keyword_metrics", { p_rows: initialRows });
    assert.equal(initialCount, 1, "expected 1 row upserted");

    // Verify initial values
    let res = await client.query(
      "SELECT * FROM public.keyword_metrics WHERE keyword = $1 AND location_code = $2 AND language_code = $3",
      [kw, location, lang]
    );
    assert.equal(res.rows.length, 1);
    let row = res.rows[0];
    assert.equal(row.search_volume, 1000);
    assert.equal(Number(row.cpc), 1.25);
    assert.equal(Number(row.competition), 0.5);
    assert.equal(row.keyword_difficulty, 40);
    assert.equal(row.intent, "commercial");
    assert.equal(row.source, "labs");
    assert.equal(row.monthly_searches.length, 1);

    // 2. Coalesce rules for labs_ranked:
    const rankedRows = [
      {
        keyword: kw,
        location_code: location,
        language_code: lang,
        search_volume: 1200,
        cpc: 1.5,
        competition: 0.9,
        keyword_difficulty: 50,
        intent: "informational",
        monthly_searches: [],
        source: "labs_ranked",
      },
    ];
    await rpc(client, "upsert_keyword_metrics", { p_rows: rankedRows });

    res = await client.query(
      "SELECT * FROM public.keyword_metrics WHERE keyword = $1 AND location_code = $2 AND language_code = $3",
      [kw, location, lang]
    );
    row = res.rows[0];
    assert.equal(row.search_volume, 1200, "search_volume updated");
    assert.equal(Number(row.cpc), 1.5, "cpc updated");
    assert.equal(row.keyword_difficulty, 50, "keyword_difficulty updated");
    assert.equal(Number(row.competition), 0.5, "competition preserved from labs");
    assert.equal(row.intent, "commercial", "intent preserved from labs");
    assert.equal(row.source, "labs", "a partial labs_ranked row keeps the stored source");
    assert.equal(row.monthly_searches.length, 1, "empty monthly_searches kept stored series");
    assert.equal(row.monthly_searches[0].search_volume, 1000);

    // 3. Duplicate keys in one batch
    const dupBatch = [
      {
        keyword: `dup-${kw}`,
        location_code: location,
        language_code: lang,
        search_volume: 500,
        cpc: 0.5,
        competition: 0.2,
        keyword_difficulty: 20,
        intent: "informational",
        monthly_searches: [],
        source: "labs",
      },
      {
        keyword: `dup-${kw}`,
        location_code: location,
        language_code: lang,
        search_volume: 600,
        cpc: 0.6,
        competition: 0.3,
        keyword_difficulty: 25,
        intent: "transactional",
        monthly_searches: [],
        source: "labs",
      },
    ];
    const dupCount = await rpc(client, "upsert_keyword_metrics", { p_rows: dupBatch });
    assert.equal(dupCount, 1, "batch with duplicate key succeeds with DISTINCT ON");

    // 4. Authenticated denied
    await client.query("SET LOCAL ROLE authenticated");
    let deniedSelect = false;
    await client.query("SAVEPOINT denied_select");
    try {
      await client.query("SELECT * FROM public.keyword_metrics LIMIT 1");
    } catch (err) {
      if (err.code === "42501") deniedSelect = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT denied_select");
    assert.equal(deniedSelect, true, "authenticated denied SELECT on keyword_metrics");

    let deniedUpsert = false;
    await client.query("SAVEPOINT denied_upsert");
    try {
      await client.query("SELECT public.upsert_keyword_metrics('[]'::jsonb)");
    } catch (err) {
      if (err.code === "42501") deniedUpsert = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT denied_upsert");
    assert.equal(deniedUpsert, true, "authenticated denied EXECUTE on upsert_keyword_metrics");

    await client.query("RESET ROLE");
  });

  // 9. prune
  await group("prune", async (client) => {
    const brand = await makeBrand(client, "prune");
    const loc = 2356;
    const lang = "en";

    const oldDate = new Date(Date.now() - 401 * 86400 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 400 * 86400 * 1000).toISOString();

    const kwUnsaved = `unsaved-${id().slice(0, 8)}`;
    const kwSaved = `saved-${id().slice(0, 8)}`;

    // Insert 2 old rows directly into keyword_metrics with fetched_at < cutoff
    await client.query(
      `INSERT INTO public.keyword_metrics(keyword, location_code, language_code, search_volume, source, fetched_at)
       VALUES ($1, $2, $3, 100, 'labs', $4), ($5, $2, $3, 200, 'labs', $4)`,
      [kwUnsaved, loc, lang, oldDate, kwSaved]
    );

    // Save kwSaved to saved_keywords
    await rpc(client, "save_keywords", {
      p_brand: brand,
      p_keywords: [kwSaved],
      p_location: loc,
      p_language: lang,
    });

    // Prune before cutoff
    const prunedCount = await rpc(client, "prune_keyword_metrics", {
      p_before: cutoff,
      p_limit: 1000,
    });
    assert.equal(prunedCount, 1, "only 1 unsaved old row was pruned");

    // kwUnsaved should be gone, kwSaved kept
    const { rows: leftUnsaved } = await client.query(
      "SELECT 1 FROM public.keyword_metrics WHERE keyword = $1",
      [kwUnsaved]
    );
    assert.equal(leftUnsaved.length, 0, "unsaved row was pruned");

    const { rows: leftSaved } = await client.query(
      "SELECT 1 FROM public.keyword_metrics WHERE keyword = $1",
      [kwSaved]
    );
    assert.equal(leftSaved.length, 1, "saved row was preserved");
  });

  console.log(`ok ${passed.length} group${passed.length === 1 ? "" : "s"}`);
} finally {
  await pool.end();
}
