#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const host = process.env.PGHOST ?? "";
const database = process.env.PGDATABASE ?? "";
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)
  || !/(?:_qa|_uat)$/.test(database)
  || process.env.DATABASE_URL) {
  throw Error("Explicit loopback _qa/_uat database required; DATABASE_URL refused");
}

const pool = new pg.Pool({ max: 3 });
const passed = [];
const id = () => crypto.randomUUID();

async function group(name, fn, { rollback = true } = {}) {
  const client = await pool.connect();
  try {
    if (rollback) await client.query("BEGIN");
    await fn(client);
    if (rollback) await client.query("ROLLBACK");
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    if (rollback) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createUser(client) {
  const userId = id();
  await client.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
    [userId, `${userId}@f16.test`],
  );
  return userId;
}

async function createBrand(client, label, ownerId = null) {
  const brandKey = `qa-f16-${label}-${id()}.example`;
  await client.query(
    "INSERT INTO customer_brands(brand_key,display_name,website,website_host) VALUES($1,$2,$3,$4)",
    [brandKey, label, `https://${brandKey}`, brandKey],
  );
  if (ownerId) {
    await client.query(
      "INSERT INTO customer_brand_memberships(user_id,brand_key,role) VALUES($1,$2,'owner')",
      [ownerId, brandKey],
    );
  }
  return brandKey;
}

async function insertTarget(client, brandKey, target, scope = "domain", enabled = true) {
  const result = await client.query(
    `INSERT INTO backlink_snapshot_targets
       (brand_key,target,scope,schedule_interval,next_run_at,approved_max_usd,enabled)
     VALUES($1,$2,$3,'weekly',now(),0.5,$4) RETURNING id`,
    [brandKey, target, scope, enabled],
  );
  return result.rows[0].id;
}

async function main() {
  await group("schema", async (client) => {
    const objects = [
      "backlink_snapshot_targets",
      "backlink_snapshots",
      "backlink_snapshot_targets_due_idx",
      "backlink_snapshots_series_idx",
    ];
    const found = await client.query(
      "SELECT to_regclass('public.' || object_name) AS object FROM unnest($1::text[]) object_name",
      [objects],
    );
    assert.equal(found.rows.filter((row) => row.object !== null).length, objects.length);
    const functions = await client.query(
      `SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname = ANY($1::text[])`,
      [["prune_backlink_snapshots", "f16_snapshot_target_cap"]],
    );
    assert.equal(functions.rows[0].count, 2, "retention and cap functions are installed");
    const policies = await client.query(
      `SELECT count(*)::int AS count FROM pg_policies
        WHERE schemaname='public' AND tablename = ANY($1::text[]) AND policyname='f16_member_read'`,
      [["backlink_snapshot_targets", "backlink_snapshots"]],
    );
    assert.equal(policies.rows[0].count, 2, "both snapshot tables have member-read RLS policies");
    const constraints = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid='public.backlink_snapshots'::regclass
          AND conname='backlink_snapshots_one_per_day'`,
    );
    assert.equal(constraints.rowCount, 1);
    const trigger = await client.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid='public.backlink_snapshot_targets'::regclass
        AND tgname='backlink_snapshot_targets_cap' AND NOT tgisinternal`,
    );
    assert.equal(trigger.rowCount, 1);
  });

  await group("rls", async (client) => {
    const userA = await createUser(client);
    const userB = await createUser(client);
    const brandA = await createBrand(client, "rls-a", userA);
    const brandB = await createBrand(client, "rls-b", userB);
    await insertTarget(client, brandA, "same.example", "subdomains");
    await insertTarget(client, brandB, "same.example", "subdomains");
    await client.query(
      `INSERT INTO backlink_snapshots(brand_key,target,scope,captured_on,source,backlinks)
       VALUES($1,'same.example','subdomains',current_date,'lookup',10),
             ($2,'same.example','subdomains',current_date,'lookup',20)`,
      [brandA, brandB],
    );
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userA]);
    for (const table of ["backlink_snapshot_targets", "backlink_snapshots"]) {
      const own = await client.query(`SELECT brand_key FROM public.${table}`);
      assert.deepEqual(own.rows.map((row) => row.brand_key), [brandA]);
    }
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userB]);
    for (const table of ["backlink_snapshot_targets", "backlink_snapshots"]) {
      const own = await client.query(`SELECT brand_key FROM public.${table}`);
      assert.deepEqual(own.rows.map((row) => row.brand_key), [brandB]);
    }
  });

  await group("caps", async (client) => {
    const brandKey = await createBrand(client, "caps");
    const targets = Array.from({ length: 19 }, (_, index) =>
      `target-${String(index + 1).padStart(2, "0")}.example`,
    );
    try {
      for (const target of targets) await insertTarget(client, brandKey, target);

      const contenders = await Promise.all([pool.connect(), pool.connect()]);
      try {
        await Promise.all(contenders.map((connection) => connection.query("BEGIN")));
        let releaseRace;
        const raceGate = new Promise((resolve) => { releaseRace = resolve; });
        const attempts = contenders.map(async (connection, index) => {
          await raceGate;
          const target = `race-${index + 1}.example`;
          try {
            await insertTarget(connection, brandKey, target);
            await connection.query("COMMIT");
            return { committed: true };
          } catch (error) {
            await connection.query("ROLLBACK");
            return { committed: false, error };
          }
        });
        releaseRace();
        const race = await Promise.all(attempts);
        assert.equal(race.filter((attempt) => attempt.committed).length, 1,
          "only one concurrent insert may claim the 20th enabled slot");
        const rejected = race.find((attempt) => !attempt.committed);
        assert.equal(rejected?.error?.message, "backlink_snapshots_cap:targets");
      } finally {
        for (const connection of contenders) connection.release();
      }

      const enabledBefore = await client.query(
        "SELECT count(*)::int AS count FROM backlink_snapshot_targets WHERE brand_key=$1 AND enabled",
        [brandKey],
      );
      assert.equal(enabledBefore.rows[0].count, 20);

      let failure;
      try {
        await insertTarget(client, brandKey, "after-race.example");
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.message, "backlink_snapshots_cap:targets");
      await client.query(
        "UPDATE backlink_snapshot_targets SET enabled=false WHERE brand_key=$1 AND target=$2",
        [brandKey, targets[0]],
      );
      await insertTarget(client, brandKey, "after-race.example");
      const enabledAfter = await client.query(
        "SELECT count(*)::int AS count FROM backlink_snapshot_targets WHERE brand_key=$1 AND enabled",
        [brandKey],
      );
      assert.equal(enabledAfter.rows[0].count, 20);
    } finally {
      await client.query("DELETE FROM customer_brands WHERE brand_key=$1", [brandKey]);
    }
  }, { rollback: false });

  await group("snapshots", async (client) => {
    const brandKey = await createBrand(client, "snapshots");
    const row = [brandKey, "daily.example", "domain"];
    const first = await client.query(
      `INSERT INTO backlink_snapshots(brand_key,target,scope,captured_on,source,backlinks)
       VALUES($1,$2,$3,current_date,'lookup',10)
       ON CONFLICT (brand_key,target,scope,captured_on) DO NOTHING`, row,
    );
    const duplicate = await client.query(
      `INSERT INTO backlink_snapshots(brand_key,target,scope,captured_on,source,backlinks)
       VALUES($1,$2,$3,current_date,'lookup',99)
       ON CONFLICT (brand_key,target,scope,captured_on) DO NOTHING`, row,
    );
    assert.equal(first.rowCount, 1);
    assert.equal(duplicate.rowCount, 0, "a second lookup for the UTC day is ignored");
    await client.query(
      `INSERT INTO backlink_snapshots(brand_key,target,scope,captured_on,source,backlinks)
       VALUES($1,$2,'subdomains',current_date,'scheduled',20),
             ($1,$2,'domain',current_date - 1,'scheduled',30)`, [brandKey, "daily.example"],
    );
    const rows = await client.query(
      "SELECT scope,captured_on FROM backlink_snapshots WHERE brand_key=$1 ORDER BY scope,captured_on",
      [brandKey],
    );
    assert.equal(rows.rowCount, 3, "scope and UTC date are part of the uniqueness key");
  });

  await group("retention", async (client) => {
    const brandKey = await createBrand(client, "retention");
    const result = await client.query(
      `INSERT INTO backlink_snapshots(brand_key,target,scope,captured_on,source,backlinks)
       VALUES($1,'old.example','domain',(current_date - interval '26 months')::date,'scheduled',1),
             ($1,'retained.example','domain',(current_date - interval '25 months')::date,'scheduled',2)`,
      [brandKey],
    );
    assert.equal(result.rowCount, 2);
    const pruned = await client.query(
      "SELECT public.prune_backlink_snapshots((current_date - interval '25 months')::date,100) AS count",
    );
    assert.equal(pruned.rows[0].count, 1);
    const retained = await client.query(
      "SELECT target FROM backlink_snapshots WHERE brand_key=$1 ORDER BY target",
      [brandKey],
    );
    assert.deepEqual(retained.rows.map((row) => row.target), ["retained.example"]);
  });

  assert.equal(passed.length, 5);
  console.log(`ok ${passed.length} groups`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "F16 DB check failed");
    process.exitCode = 1;
  })
  .finally(async () => { await pool.end(); });
