#!/usr/bin/env node
/**
 * F09 database harness:
 *   1. quote-equals-reservation (F09-AC-02)
 *   2. approved-cap (F09-AC-03)
 *   3. approval-records (F09-AC-05)
 *
 * Runs against a disposable loopback PostgreSQL database that has every
 * migration applied.
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
    "F09 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused",
  );
}

const pool = new pg.Pool({ max: 24 });
const passed = [];
const query = (sql, values = []) => pool.query(sql, values);

const toMicros = (d) => Math.round(Number(d) * 1e6);
const fromMicros = (m) => m / 1e6;

async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await query(
    `SELECT ${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")}) AS result`,
    entries.map(([, v]) =>
      typeof v === "object" && v !== null ? JSON.stringify(v) : v,
    ),
  );
  return result.rows[0].result;
}

async function runGroup(groupName, fn) {
  await fn();
  passed.push(groupName);
  console.log(`PASS ${groupName}`);
}

async function createUser(email) {
  const userId = crypto.randomUUID();
  await query(
    "INSERT INTO auth.users(id, email, email_confirmed_at) VALUES($1, $2, now()) ON CONFLICT (id) DO NOTHING",
    [userId, email],
  );
  return userId;
}

async function createBrand(suffix, ownerUserId = null) {
  const brandKey = `qa-f09-${suffix}-${crypto.randomUUID()}.example`;
  await query(
    "INSERT INTO public.customer_brands(brand_key, display_name, website, website_host, aliases) VALUES($1, $2, $3, $4, $5)",
    [brandKey, `F09 ${suffix}`, `https://${brandKey}`, brandKey, []],
  );
  if (ownerUserId) {
    await query(
      "INSERT INTO public.customer_brand_memberships(user_id, brand_key, role) VALUES($1, $2, 'owner')",
      [ownerUserId, brandKey],
    );
  }
  return brandKey;
}

async function ensureDispatchControl(brandKey) {
  // Inside the disposable QA database ONLY: never touch probe_dispatch_control on a shared database.
  await query(
    "UPDATE public.probe_dispatch_control SET paused = false, brand_allowlist = array_append(brand_allowlist, $1) WHERE singleton = true",
    [brandKey],
  );
}

try {
  // -------------------------------------------------------------------------
  // Group 1: quote-equals-reservation (F09-AC-02)
  // -------------------------------------------------------------------------
  await runGroup("quote-equals-reservation", async () => {
    const pairs = [
      { reserve: 0.2, n: 1 },
      { reserve: 1.0, n: 7 },
      { reserve: 0.15, n: 120 },
      { reserve: 0.333333, n: 800 },
    ];

    for (const { reserve, n } of pairs) {
      const quote = fromMicros(n * toMicros(reserve));
      const brandKey = await createBrand(`quote-${n}`);
      await ensureDispatchControl(brandKey);

      const jobId = crypto.randomUUID();
      const circuitKey = crypto.randomUUID();

      await query(
        "INSERT INTO public.scan_jobs(id, brand, brand_key, url, status, approved_max_usd) VALUES($1, $2, $3, 'https://example.com', 'probing', $4)",
        [jobId, brandKey, brandKey, quote],
      );

      const rows = Array.from({ length: n }, (_, i) => ({
        id: crypto.randomUUID(),
        job_id: jobId,
        purpose: "scan",
        engine: "chatgpt",
        query: `Question ${i}?`,
        context: {
          sourcing_cost: 0,
          budget_scope: crypto.randomUUID(),
          max_requests: 100,
          request_units: 1,
        },
        config_version: "fixture-v1",
        circuit_key: circuitKey,
        deadline_at: new Date(Date.now() + 3600_000).toISOString(),
      }));

      // Seed observations via RPC in batches of 200
      const BATCH_SIZE = 200;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        await rpc("seed_probe_observations", {
          p_rows: rows.slice(i, i + BATCH_SIZE),
        });
      }

      // Claim all observations: with p_scan_cap = quote, all first attempts must be granted
      for (let i = 0; i < rows.length; i++) {
        const claim = await rpc("claim_probe_dispatch", {
          p_id: rows[i].id,
          p_reserve: reserve,
          p_scan_cap: quote,
          p_day_cap: null,
          p_lease_seconds: 120,
        });
        assert.equal(
          claim.granted,
          true,
          `claim ${i} of ${n} (reserve ${reserve}) must be granted`,
        );
      }

      // sum(reserved_usd) = quote exactly in SQL numeric
      const sumRes = await query(
        "SELECT sum(reserved_usd)::numeric(12,6) AS total FROM public.probe_attempts WHERE observation_id = ANY($1)",
        [rows.map((r) => r.id)],
      );
      const totalNumeric = parseFloat(sumRes.rows[0].total);
      assert.equal(
        totalNumeric,
        quote,
        `sum(reserved_usd) (${totalNumeric}) must equal quote (${quote}) for reserve ${reserve}, N ${n}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Group 2: approved-cap (F09-AC-03)
  // -------------------------------------------------------------------------
  await runGroup("approved-cap", async () => {
    const brandKey = await createBrand("approved-cap");
    await ensureDispatchControl(brandKey);

    const n = 3;
    const reserve = 1.0;
    const approvedMax = 3.0; // M = 3.0
    const jobId = crypto.randomUUID();
    const circuitKey = crypto.randomUUID();

    await query(
      "INSERT INTO public.scan_jobs(id, brand, brand_key, url, status, approved_max_usd) VALUES($1, $2, $3, 'https://example.com', 'probing', $4)",
      [jobId, brandKey, brandKey, approvedMax],
    );

    const rows = Array.from({ length: n }, (_, i) => ({
      id: crypto.randomUUID(),
      job_id: jobId,
      purpose: "scan",
      engine: "chatgpt",
      query: `Cap question ${i}?`,
      context: {
        sourcing_cost: 0,
        budget_scope: crypto.randomUUID(),
        max_requests: 100,
        request_units: 1,
      },
      config_version: "fixture-v1",
      circuit_key: circuitKey,
      deadline_at: new Date(Date.now() + 3600_000).toISOString(),
    }));

    await rpc("seed_probe_observations", { p_rows: rows });

    // Claim and finish k attempts with charged = reserve
    for (let i = 0; i < n; i++) {
      const claim = await rpc("claim_probe_dispatch", {
        p_id: rows[i].id,
        p_reserve: reserve,
        p_scan_cap: approvedMax,
        p_day_cap: null,
        p_lease_seconds: 120,
      });
      assert.equal(claim.granted, true, `attempt ${i} must be granted`);

      // Finish attempt with charged_usd = reserve
      await rpc("finish_probe_dispatch", {
        p_id: rows[i].id,
        p_token: claim.lease_token,
        p_result: { cost: reserve, answer_present: true, text: `Answer ${i}` },
        p_state: i === 0 ? "retry" : "answered", // observation 0 set to retry
        p_failure: i === 0 ? { kind: "transient_error" } : null,
        p_next_at: i === 0 ? new Date(Date.now() - 1000).toISOString() : null,
      });
    }

    // Now committed probe spend = 3 * 1.0 = 3.0 = approvedMax.
    // The (N+1)-th claim (a retry of observation 0) must be refused with spend_reservation_refused
    const retryClaim = await rpc("claim_probe_dispatch", {
      p_id: rows[0].id,
      p_reserve: reserve,
      p_scan_cap: approvedMax,
      p_day_cap: null,
      p_lease_seconds: 120,
    });

    assert.equal(retryClaim.granted, false, "retry claim must not be granted");
    assert.equal(
      retryClaim.reason,
      "spend_reservation_refused",
      "retry claim must be refused with spend_reservation_refused",
    );

    // Verify scan spend never exceeds M
    const spendRes = await query(
      `SELECT coalesce(sum(coalesce(a.charged_usd, a.reserved_usd)), 0)::numeric(12,6) AS scan_spend
         FROM public.probe_attempts a
         JOIN public.probe_observations o ON o.id = a.observation_id
        WHERE o.job_id = $1`,
      [jobId],
    );
    const finalSpend = parseFloat(spendRes.rows[0].scan_spend);
    assert.ok(
      finalSpend <= approvedMax,
      `scan spend (${finalSpend}) must never exceed approved maximum (${approvedMax})`,
    );
  });

  // -------------------------------------------------------------------------
  // Group 3: approval-records (F09-AC-05)
  // -------------------------------------------------------------------------
  await runGroup("approval-records", async () => {
    const userA = await createUser(`qa-f09-user-a-${crypto.randomUUID()}@example.test`);
    const userB = await createUser(`qa-f09-user-b-${crypto.randomUUID()}@example.test`);

    const brandA = await createBrand("tenant-a", userA);
    const brandB = await createBrand("tenant-b", userB);

    const jobIdA = crypto.randomUUID();
    const jobIdB = crypto.randomUUID();
    const jobIdOld = crypto.randomUUID();

    // Insert approvals
    await query(
      `INSERT INTO public.price_approvals (
        brand_key, action, approved_max_usd, quoted_usd, source, quote, price_version, subject_kind, subject_id, approved_by
      ) VALUES ($1, 'ai_visibility.scan.run', 25.0, 24.0, 'dialog', '{"totalUsd": 24.0}'::jsonb, '2026-10-21.1', 'scan_job', $2, $3)`,
      [brandA, jobIdA, userA],
    );

    await query(
      `INSERT INTO public.price_approvals (
        brand_key, action, approved_max_usd, quoted_usd, source, quote, price_version, subject_kind, subject_id, approved_by
      ) VALUES ($1, 'ai_visibility.scan.run', 30.0, 30.0, 'implicit', '{"totalUsd": 30.0}'::jsonb, '2026-10-21.1', 'scan_job', $2, $3)`,
      [brandB, jobIdB, userB],
    );

    // Verify RLS for User A
    const clientA = new pg.Client({ host, database });
    await clientA.connect();
    try {
      await clientA.query("SET LOCAL ROLE authenticated;");
      await clientA.query("SELECT set_config('request.jwt.claim.sub', $1, true);", [userA]);
      const resA = await clientA.query("SELECT * FROM public.price_approvals;");
      assert.equal(resA.rows.length, 1, "User A must see exactly 1 approval");
      assert.equal(resA.rows[0].brand_key, brandA, "User A must see Brand A approval");
    } finally {
      await clientA.end();
    }

    // Verify RLS for User B
    const clientB = new pg.Client({ host, database });
    await clientB.connect();
    try {
      await clientB.query("SET LOCAL ROLE authenticated;");
      await clientB.query("SELECT set_config('request.jwt.claim.sub', $1, true);", [userB]);
      const resB = await clientB.query("SELECT * FROM public.price_approvals;");
      assert.equal(resB.rows.length, 1, "User B must see exactly 1 approval");
      assert.equal(resB.rows[0].brand_key, brandB, "User B must see Brand B approval");
    } finally {
      await clientB.end();
    }

    // Insert an approval row older than 395 days
    await query(
      `INSERT INTO public.price_approvals (
        brand_key, action, approved_max_usd, quoted_usd, source, quote, price_version, subject_kind, subject_id, approved_by, created_at
      ) VALUES ($1, 'ai_visibility.scan.run', 25.0, 24.0, 'dialog', '{"totalUsd": 24.0}'::jsonb, '2026-10-21.1', 'scan_job', $2, $3, now() - interval '400 days')`,
      [brandA, jobIdOld, userA],
    );

    // Call prune_price_approvals(now() - interval '395 days', 5000)
    const pruneRes = await query(
      "SELECT public.prune_price_approvals(now() - interval '395 days', 5000) AS pruned",
    );
    const prunedCount = pruneRes.rows[0].pruned;
    assert.ok(prunedCount >= 1, "prune_price_approvals must prune at least 1 old approval");

    // Verify the old row was deleted and recent rows were kept
    const checkOld = await query(
      "SELECT count(*)::int AS cnt FROM public.price_approvals WHERE subject_id = $1",
      [jobIdOld],
    );
    assert.equal(checkOld.rows[0].cnt, 0, "400-day-old approval must be pruned");

    const checkRecent = await query(
      "SELECT count(*)::int AS cnt FROM public.price_approvals WHERE subject_id = $1",
      [jobIdA],
    );
    assert.equal(checkRecent.rows[0].cnt, 1, "recent approval must not be pruned");
  });

  console.log(`\nAll ${passed.length} groups passed: ${passed.join(", ")}`);
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err);
  process.exit(1);
} finally {
  await pool.end();
}
