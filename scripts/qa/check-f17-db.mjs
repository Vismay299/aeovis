#!/usr/bin/env node
/**
 * F17 database harness (migrations 120 and 121):
 *   - 120: local_businesses, local_fetches, local_fetch_items, local_grid_runs, local_searches
 *          with RLS and member read policies
 *   - 121: save_local_business, find_local_reuse, claim_local_poll, prune_local_seo
 *
 * Groups: schema, rls, caps, reuse, poll, retention. Each group runs in its own
 * transaction that is rolled back, so the database is left unchanged.
 *
 * Runs against a disposable loopback PostgreSQL database that already has
 * tests/supabase-bootstrap.sql and every migration applied.
 * Usage:
 *   PGHOST=127.0.0.1 PGDATABASE=<name>_qa node scripts/qa/check-f17-db.mjs
 *   PGHOST=127.0.0.1 PGDATABASE=<name>_qa node scripts/qa/check-f17-db.mjs --only retention
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const host = process.env.PGHOST || "";
const database = process.env.PGDATABASE || "";
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "F17 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused"
  );
}

const GROUPS = ["schema", "rls", "caps", "reuse", "poll", "retention"];
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];
if (only !== null && !GROUPS.includes(only)) {
  throw new Error(`Unknown group "${only}". Groups: ${GROUPS.join(", ")}`);
}

const TABLES = ["local_businesses", "local_fetches", "local_fetch_items", "local_grid_runs", "local_searches"];
const FUNCTIONS = ["save_local_business", "find_local_reuse", "claim_local_poll", "prune_local_seo"];
const SAVE_ARGS =
  "$1::text,$2::text,$3::text,$4::text,$5::text,$6::numeric,$7::numeric,$8::integer,$9::text,$10::jsonb,$11::uuid";

const pool = new pg.Pool({ max: 2 });
const id = () => crypto.randomUUID();
const hash = (n) => String(n).repeat(64).slice(0, 64);

async function createUser(c, prefix) {
  const userId = id();
  await c.query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())", [
    userId,
    `${prefix}-${userId}@example.test`,
  ]);
  return userId;
}

async function createBrand(c, ownerUserId) {
  const brandKey = `qa-f17-${id()}.example`;
  await c.query(
    "INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, is_active) VALUES ($1, $1, $2, $1, true)",
    [brandKey, `https://${brandKey}`]
  );
  if (ownerUserId) {
    await c.query("INSERT INTO public.customer_brand_memberships (user_id, brand_key, role) VALUES ($1, $2, 'owner')", [
      ownerUserId,
      brandKey,
    ]);
  }
  return brandKey;
}

async function save(c, brand, role, title, cid, placeId = null) {
  const r = await c.query(`SELECT public.save_local_business(${SAVE_ARGS}) AS id`, [
    brand, role, title, cid, placeId, null, null, null, "en", null, null,
  ]);
  return r.rows[0].id;
}

// Runs sql inside a savepoint and returns the error message (or null when it succeeded).
async function failure(c, sql, values = []) {
  await c.query("SAVEPOINT f17_probe");
  try {
    await c.query(sql, values);
    await c.query("RELEASE SAVEPOINT f17_probe");
    return null;
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT f17_probe");
    return String(error.message || error);
  }
}

async function insertFetch(c, brand, { businessId = null, requestId = id(), params = hash("a"), status = "processing", createdAt = null } = {}) {
  const r = await c.query(
    `INSERT INTO public.local_fetches (brand_key, request_id, business_id, kind, identifier, params, params_hash, status, created_at)
     VALUES ($1, $2, $3, 'reviews', '{"cid":"1"}', '{"depth":20}', $4, $5, coalesce($6::timestamptz, now())) RETURNING id`,
    [brand, requestId, businessId, params, status, createdAt]
  );
  return r.rows[0].id;
}

async function insertGrid(c, brand, { requestId = id(), params = hash("b"), status = "processing", createdAt = null } = {}) {
  const r = await c.query(
    `INSERT INTO public.local_grid_runs (brand_key, request_id, keyword, center_lat, center_lng, grid_size, spacing_km, zoom,
       device, language_code, target, params_hash, status, created_at)
     VALUES ($1, $2, 'coffee store', 19.076, 72.8777, 3, 2, 13, 'mobile', 'en', '{"cid":"1"}', $3, $4, coalesce($5::timestamptz, now()))
     RETURNING id`,
    [brand, requestId, params, status, createdAt]
  );
  return r.rows[0].id;
}

async function insertSearch(c, brand, createdAt = null) {
  await c.query(
    `INSERT INTO public.local_searches (brand_key, kind, params, result_count, cache_key, cached, created_at)
     VALUES ($1, 'local_serp', '{"keyword":"coffee store"}', 3, $2, false, coalesce($3::timestamptz, now()))`,
    [brand, hash("c"), createdAt]
  );
}

const groups = {
  async schema(c) {
    const tables = await c.query(
      "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)",
      [TABLES]
    );
    assert.equal(tables.rows.length, TABLES.length, "all five tables exist");
    for (const row of tables.rows) assert.ok(row.relrowsecurity, `${row.relname} has RLS enabled`);
    const policies = await c.query(
      "SELECT tablename, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)",
      [TABLES]
    );
    for (const t of TABLES) {
      const mine = policies.rows.filter((p) => p.tablename === t);
      assert.equal(mine.length, 1, `${t} has exactly one policy`);
      assert.equal(mine[0].cmd, "SELECT", `${t} policy is read-only`);
    }
    const fns = await c.query(
      "SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1)",
      [FUNCTIONS]
    );
    assert.equal(fns.rows.length, FUNCTIONS.length, "all four functions exist");
    for (const f of fns.rows) {
      assert.equal(f.auth_exec, false, `${f.proname} is not executable by authenticated`);
      assert.equal(f.svc_exec, true, `${f.proname} is executable by service_role`);
    }
    // Check constraints and the composite foreign key.
    const brand = await createBrand(c, null);
    assert.match(await failure(c, "INSERT INTO public.local_businesses (brand_key, role, title) VALUES ($1, 'own', 'x')", [brand]), /local_businesses_identity/, "identity required");
    assert.match(await failure(c, "INSERT INTO public.local_businesses (brand_key, role, title, cid) VALUES ($1, 'boss', 'x', '1')", [brand]), /role_check/, "role check");
    assert.match(await failure(c, "INSERT INTO public.local_businesses (brand_key, role, title, cid) VALUES ($1, 'own', 'x', 'abc')", [brand]), /cid_check/, "cid shape");
    assert.match(await failure(c, "INSERT INTO public.local_businesses (brand_key, role, title, cid, latitude) VALUES ($1, 'own', 'x', '1', 91)", [brand]), /latitude_check|numeric field overflow/, "latitude range");
    assert.match(await failure(c, "INSERT INTO public.local_fetches (brand_key, request_id, kind, identifier, params, params_hash) VALUES ($1, $2, 'reviews', '{}', '{}', 'short')", [brand, id()]), /params_hash_check/, "params_hash shape");
    assert.match(await failure(c, "INSERT INTO public.local_grid_runs (brand_key, request_id, keyword, center_lat, center_lng, grid_size, spacing_km, zoom, device, language_code, target, params_hash) VALUES ($1, $2, 'k', 1, 1, 4, 2, 13, 'mobile', 'en', '{}', $3)", [brand, id(), hash("d")]), /grid_size_check/, "grid size 3 or 5");
    const otherBrand = await createBrand(c, null);
    const fetchId = await insertFetch(c, brand);
    assert.match(await failure(c, "INSERT INTO public.local_fetch_items (fetch_id, brand_key, idx, item) VALUES ($1, $2, 0, '{}')", [fetchId, otherBrand]), /local_fetch_items_fetch_fk/, "composite fk rejects another brand");
    const requestId = id();
    await insertFetch(c, brand, { requestId, params: hash("e") });
    assert.match(await failure(c, "INSERT INTO public.local_fetches (brand_key, request_id, kind, identifier, params, params_hash) VALUES ($1, $2, 'reviews', '{}', '{}', $3)", [brand, requestId, hash("f")]), /duplicate key/, "request_id unique");
    // Deleting a saved business keeps history and brand_key.
    const bizId = await save(c, brand, "own", "Store", "111");
    const keptFetch = await insertFetch(c, brand, { businessId: bizId, params: hash("1") });
    await c.query("DELETE FROM public.local_businesses WHERE id = $1", [bizId]);
    const kept = await c.query("SELECT business_id, brand_key FROM public.local_fetches WHERE id = $1", [keptFetch]);
    assert.equal(kept.rows[0].business_id, null, "business_id nulled on delete");
    assert.equal(kept.rows[0].brand_key, brand, "brand_key kept on delete");
  },

  async rls(c) {
    const userA = await createUser(c, "usera");
    const userB = await createUser(c, "userb");
    const brandA = await createBrand(c, userA);
    const brandB = await createBrand(c, userB);
    for (const [brand, cid] of [[brandA, "100"], [brandB, "200"]]) {
      const biz = await save(c, brand, "own", `Store ${cid}`, cid);
      const fetchId = await insertFetch(c, brand, { businessId: biz, params: hash(cid[0]) });
      await c.query("INSERT INTO public.local_fetch_items (fetch_id, brand_key, idx, item) VALUES ($1, $2, 0, '{}')", [fetchId, brand]);
      await insertGrid(c, brand, { params: hash(cid[0]) });
      await insertSearch(c, brand);
    }
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userA]);
    for (const t of TABLES) {
      const r = await c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE brand_key = $1)::int AS mine FROM public.${t}`, [brandA]);
      assert.deepEqual(r.rows[0], { n: 1, mine: 1 }, `${t}: user A sees only workspace A`);
    }
    assert.match(await failure(c, "INSERT INTO public.local_searches (brand_key, kind, params, result_count, cache_key, cached) VALUES ($1, 'local_serp', '{}', 0, $2, false)", [brandA, hash("9")]), /permission denied/, "no insert for authenticated");
    assert.match(await failure(c, "UPDATE public.local_businesses SET title = 'x'"), /permission denied/, "no update for authenticated");
    assert.match(await failure(c, "SELECT public.find_local_reuse($1, 'fetch', $2, now())", [brandA, hash("1")]), /permission denied/, "functions are service-only");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [id()]);
    for (const t of TABLES) {
      const r = await c.query(`SELECT count(*)::int AS n FROM public.${t}`);
      assert.equal(r.rows[0].n, 0, `${t}: a non-member sees nothing`);
    }
    await c.query("RESET ROLE");
  },

  async caps(c) {
    const brand = await createBrand(c, null);
    const first = await save(c, brand, "own", "First", "1001");
    const second = await save(c, brand, "own", "Second", "1002");
    const roles = await c.query("SELECT id, role FROM public.local_businesses WHERE brand_key = $1", [brand]);
    assert.equal(roles.rows.filter((r) => r.role === "own").length, 1, "exactly one own business");
    assert.equal(roles.rows.find((r) => r.id === first).role, "competitor", "second own demotes the first to competitor");
    assert.equal(roles.rows.find((r) => r.id === second).role, "own", "second becomes own");
    // Re-saving the same CID updates in place rather than inserting.
    const again = await save(c, brand, "own", "Second renamed", "1002");
    assert.equal(again, second, "same CID returns the same row");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM public.local_businesses WHERE brand_key = $1", [brand])).rows[0].n, 2);
    // Fill to 10 competitors (the demoted First is one), then the 11th raises.
    for (let i = 2; i <= 10; i += 1) await save(c, brand, "competitor", `Competitor ${i}`, String(2000 + i));
    const count = await c.query("SELECT count(*)::int AS n FROM public.local_businesses WHERE brand_key = $1 AND role = 'competitor'", [brand]);
    assert.equal(count.rows[0].n, 10, "ten competitors allowed");
    assert.match(
      await failure(c, `SELECT public.save_local_business(${SAVE_ARGS})`, [brand, "competitor", "Eleventh", "3000", null, null, null, null, "en", null, null]),
      /local_business_cap:competitors/,
      "11th competitor raises"
    );
    assert.match(
      await failure(c, `SELECT public.save_local_business(${SAVE_ARGS})`, [brand, "viewer", "Bad", "3001", null, null, null, null, "en", null, null]),
      /local_business_invalid:role/,
      "invalid role raises"
    );
    // A new own business must not push the demoted old own past ten competitors (F17-AC-01 and AC-10).
    const ownBefore = (await c.query("SELECT id FROM public.local_businesses WHERE brand_key = $1 AND role = 'own'", [brand])).rows[0].id;
    assert.match(
      await failure(c, `SELECT public.save_local_business(${SAVE_ARGS})`, [brand, "own", "Third own", "3002", null, null, null, null, "en", null, null]),
      /local_business_cap:competitors/,
      "a new own business with ten competitors raises"
    );
    const after = await c.query("SELECT role, count(*)::int AS n FROM public.local_businesses WHERE brand_key = $1 GROUP BY role", [brand]);
    assert.deepEqual(Object.fromEntries(after.rows.map((r) => [r.role, r.n])), { own: 1, competitor: 10 }, "the demotion rolled back");
    assert.equal((await c.query("SELECT role FROM public.local_businesses WHERE id = $1", [ownBefore])).rows[0].role, "own", "the old own is still own");
    // Promoting an existing competitor to own is net zero and succeeds, leaving ten competitors.
    const promote = (await c.query("SELECT cid FROM public.local_businesses WHERE brand_key = $1 AND role = 'competitor' ORDER BY cid LIMIT 1", [brand])).rows[0].cid;
    await save(c, brand, "own", "Promoted", promote);
    const final = await c.query("SELECT role, count(*)::int AS n FROM public.local_businesses WHERE brand_key = $1 GROUP BY role", [brand]);
    assert.deepEqual(Object.fromEntries(final.rows.map((r) => [r.role, r.n])), { own: 1, competitor: 10 }, "promotion keeps ten competitors");
    assert.equal((await c.query("SELECT role FROM public.local_businesses WHERE id = $1", [ownBefore])).rows[0].role, "competitor", "the old own was demoted by the promotion");
    // Another workspace has its own independent caps.
    const other = await createBrand(c, null);
    await save(c, other, "competitor", "Elsewhere", "1001");
  },

  async reuse(c) {
    const brand = await createBrand(c, null);
    const other = await createBrand(c, null);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await insertFetch(c, brand, { params: hash("1"), status: "completed" });
    const processing = await insertFetch(c, brand, { params: hash("2"), status: "processing" });
    await insertFetch(c, brand, { params: hash("3"), status: "failed" });
    await insertFetch(c, brand, { params: hash("4"), status: "completed", createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const find = async (table, h, b = brand) =>
      (await c.query("SELECT public.find_local_reuse($1, $2, $3, $4::timestamptz) AS id", [b, table, h, since])).rows[0].id;
    assert.equal(await find("fetch", hash("1")), recent, "completed fetch inside the window is reused");
    assert.equal(await find("fetch", hash("2")), processing, "processing fetch inside the window is reused");
    assert.equal(await find("fetch", hash("3")), null, "failed fetch is excluded");
    assert.equal(await find("fetch", hash("4")), null, "fetch older than the window is excluded");
    assert.equal(await find("fetch", hash("1"), other), null, "another workspace never matches");
    const grid = await insertGrid(c, brand, { params: hash("5"), status: "completed" });
    await insertGrid(c, brand, { params: hash("6"), status: "failed" });
    assert.equal(await find("grid", hash("5")), grid, "completed grid is reused");
    assert.equal(await find("grid", hash("6")), null, "failed grid is excluded");
    assert.match(await failure(c, "SELECT public.find_local_reuse($1, 'nope', $2, now())", [brand, hash("1")]), /local_reuse_invalid/, "unknown table raises");
  },

  async poll(c) {
    const brand = await createBrand(c, null);
    const fetchId = await insertFetch(c, brand);
    const claim = async (table, rowId, b = brand) =>
      (await c.query("SELECT public.claim_local_poll($1, $2, $3, 4) AS ok", [b, table, rowId])).rows[0].ok;
    assert.equal(await claim("fetch", fetchId), true, "first claim succeeds");
    assert.equal(await claim("fetch", fetchId), false, "second claim within 4 s fails");
    await c.query("UPDATE public.local_fetches SET last_polled_at = now() - interval '10 seconds' WHERE id = $1", [fetchId]);
    assert.equal(await claim("fetch", fetchId), true, "claim succeeds again after 4 s");
    const gridId = await insertGrid(c, brand);
    assert.equal(await claim("grid", gridId), true, "grid first claim succeeds");
    assert.equal(await claim("grid", gridId), false, "grid second claim within 4 s fails");
    const done = await insertFetch(c, brand, { params: hash("7"), status: "completed" });
    assert.equal(await claim("fetch", done), false, "a completed fetch is never claimed");
    const other = await createBrand(c, null);
    const fresh = await insertFetch(c, brand, { params: hash("8") });
    assert.equal(await claim("fetch", fresh, other), false, "another workspace cannot claim");
    assert.match(await failure(c, "SELECT public.claim_local_poll($1, 'nope', $2, 4)", [brand, fetchId]), /local_poll_invalid/, "unknown table raises");
  },

  async retention(c) {
    const brand = await createBrand(c, null);
    const old = new Date(Date.now() - 400 * 86400 * 1000).toISOString();
    const recentAt = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const oldFetch = await insertFetch(c, brand, { params: hash("1"), createdAt: old });
    await c.query("INSERT INTO public.local_fetch_items (fetch_id, brand_key, idx, item) VALUES ($1, $2, 0, '{}')", [oldFetch, brand]);
    const keptFetch = await insertFetch(c, brand, { params: hash("2"), createdAt: recentAt });
    await c.query("INSERT INTO public.local_fetch_items (fetch_id, brand_key, idx, item) VALUES ($1, $2, 0, '{}')", [keptFetch, brand]);
    await insertGrid(c, brand, { params: hash("3"), createdAt: old });
    await insertGrid(c, brand, { params: hash("4"), createdAt: recentAt });
    await insertSearch(c, brand, old);
    await insertSearch(c, brand, recentAt);
    const before = new Date(Date.now() - 395 * 86400 * 1000).toISOString();
    const r = await c.query("SELECT public.prune_local_seo($1::timestamptz, 1000) AS result", [before]);
    const counts = r.rows[0].result;
    assert.ok(counts.fetches >= 1 && counts.grids >= 1 && counts.searches >= 1, `prune reports each table: ${JSON.stringify(counts)}`);
    const left = async (t) => (await c.query(`SELECT count(*)::int AS n FROM public.${t} WHERE brand_key = $1`, [brand])).rows[0].n;
    assert.equal(await left("local_fetches"), 1, "only the recent fetch remains");
    assert.equal(await left("local_fetch_items"), 1, "items of the pruned fetch cascade away");
    assert.equal(await left("local_grid_runs"), 1, "only the recent grid remains");
    assert.equal(await left("local_searches"), 1, "only the recent search remains");
    // The per-call limit bounds work: limit 1 prunes at most one row per table.
    await insertFetch(c, brand, { params: hash("5"), createdAt: old });
    await insertFetch(c, brand, { params: hash("6"), createdAt: old });
    const limited = (await c.query("SELECT public.prune_local_seo($1::timestamptz, 1) AS result", [before])).rows[0].result;
    assert.ok(limited.fetches <= 1, "limit 1 prunes at most one fetch");
  },
};

const passed = [];
try {
  for (const name of GROUPS) {
    if (only && only !== name) continue;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await groups[name](c);
      passed.push(name);
      console.log(`PASS ${name}`);
    } finally {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* keep the original failure */
      }
      c.release();
    }
  }
  console.log(`ok ${passed.length} groups`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
