#!/usr/bin/env node
// F13 database harness: migration 101 (keyword_metrics, upsert_keyword_metrics, prune_keyword_metrics)
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

try {
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
    // labs_ranked provides volume, cpc, kd; keeps existing competition and intent
    const rankedRows = [
      {
        keyword: kw,
        location_code: location,
        language_code: lang,
        search_volume: 1200,
        cpc: 1.5,
        competition: 0.9, // should be IGNORED
        keyword_difficulty: 50,
        intent: "informational", // should be IGNORED
        monthly_searches: [], // empty: should KEEP stored series
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
    assert.equal(row.source, "labs_ranked", "source updated to labs_ranked");
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
    try {
      await client.query("SELECT * FROM public.keyword_metrics LIMIT 1");
    } catch (err) {
      if (err.code === "42501") deniedSelect = true;
    }
    assert.equal(deniedSelect, true, "authenticated denied SELECT on keyword_metrics");

    let deniedUpsert = false;
    try {
      await client.query("SELECT public.upsert_keyword_metrics('[]'::jsonb)");
    } catch (err) {
      if (err.code === "42501") deniedUpsert = true;
    }
    assert.equal(deniedUpsert, true, "authenticated denied EXECUTE on upsert_keyword_metrics");

    await client.query("RESET ROLE");
  });

  console.log(`ok ${passed.length} group${passed.length === 1 ? "" : "s"}`);
} finally {
  await pool.end();
}
