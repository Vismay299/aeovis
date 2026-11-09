#!/usr/bin/env node
// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/AuditScratchpad.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F18 database harness (migrations 125 and 126):
 *   - 125: site_audits, site_audit_pages, site_audit_issues, site_audit_lighthouse,
 *          site_audit_frontier, site_audit_links, storage bucket site-audit-lighthouse, RLS
 *   - 126: site_audit_create, site_audit_seed, site_audit_frontier_stats,
 *          site_audit_claim_chunk, site_audit_record_batch, site_audit_release,
 *          site_audit_abandon_chunk, site_audit_broken_links, site_audit_orphan_pages,
 *          site_audit_issue_summary, site_audit_destroy_scratch, prune_site_audits
 *
 * Runs against a disposable loopback PostgreSQL database.
 * Usage:
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f18-db.mjs
 *   PGHOST=localhost PGDATABASE=customer_uat node scripts/qa/check-f18-db.mjs --only schema
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createSqlAuditStore } from "../../src/lib/audit/store.ts";
import { createMemoryAuditStore } from "../../src/lib/audit/memoryStore.ts";

const host = process.env.PGHOST || "";
const database = process.env.PGDATABASE || "";
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  !/(?:_qa|_uat)$/.test(database) ||
  process.env.DATABASE_URL
) {
  throw new Error(
    "F18 database tests require explicit loopback PGHOST and disposable *_qa/*_uat PGDATABASE; DATABASE_URL is refused"
  );
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pool = new pg.Pool({ max: 8 });
const query = (sql, values = []) => pool.query(sql, values);
const id = () => crypto.randomUUID();

async function apply125And126() {
  const sql125 = fs.readFileSync(path.join(ROOT, "supabase/migrations/125_f18_site_audit.sql"), "utf8");
  const sql126 = fs.readFileSync(path.join(ROOT, "supabase/migrations/126_f18_site_audit_functions.sql"), "utf8");
  await query(sql125);
  await query(sql126);
}

if (process.argv.includes("--only") && process.argv[process.argv.indexOf("--only") + 1] === "schema") {
  try {
    await apply125And126();
    await apply125And126();
    console.log("125/126 applied twice without error");
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("Failed to apply 125/126:", err);
    await pool.end();
    process.exit(1);
  }
}

function createPgAdminAdapter(client) {
  return {
    async rpc(name, params = {}) {
      const entries = Object.entries(params);
      const sql = `SELECT ${name}(${entries.map(([k], i) => `${k} => $${i + 1}`).join(", ")}) AS result`;
      const values = entries.map(([, v]) => {
        if (v === null || v === undefined) return null;
        if (typeof v === "object") return JSON.stringify(v);
        return v;
      });
      const res = await client.query(sql, values);
      return { data: res.rows[0]?.result ?? null, error: null };
    },

    from(table) {
      let whereClauses = [];
      let whereValues = [];
      let selectedCols = "*";
      let limitCount = null;
      let orderCol = null;
      let orderAsc = true;
      let isSingle = false;
      let isCountOnly = false;

      const builder = {
        select(cols = "*", opts = {}) {
          selectedCols = cols;
          if (opts.head && opts.count === "exact") {
            isCountOnly = true;
          }
          return builder;
        },

        eq(col, val) {
          whereValues.push(val);
          whereClauses.push(`${col} = $${whereValues.length}`);
          return builder;
        },

        in(col, vals) {
          whereValues.push(vals);
          whereClauses.push(`${col} = ANY($${whereValues.length})`);
          return builder;
        },

        gte(col, val) {
          whereValues.push(val);
          whereClauses.push(`${col} >= $${whereValues.length}`);
          return builder;
        },

        lt(col, val) {
          whereValues.push(val);
          whereClauses.push(`${col} < $${whereValues.length}`);
          return builder;
        },

        gt(col, val) {
          whereValues.push(val);
          whereClauses.push(`${col} > $${whereValues.length}`);
          return builder;
        },

        order(col, opts = { ascending: true }) {
          orderCol = col;
          orderAsc = Boolean(opts.ascending);
          return builder;
        },

        limit(n) {
          limitCount = n;
          return builder;
        },

        async maybeSingle() {
          isSingle = true;
          limitCount = 1;
          const { data, error } = await builder;
          return { data: data?.[0] ?? null, error };
        },

        async update(patch) {
          const patchEntries = Object.entries(patch);
          const updateBuilder = {
            eq(col, val) {
              builder.eq(col, val);
              return updateBuilder;
            },
            in(col, vals) {
              builder.in(col, vals);
              return updateBuilder;
            },
            select(cols = "*") {
              selectedCols = cols;
              return updateBuilder;
            },
            async then(resolve, reject) {
              try {
                const setClauses = patchEntries.map(
                  ([k], i) => `${k} = $${whereValues.length + i + 1}`
                );
                const patchVals = patchEntries.map(([, v]) => {
                  if (v === null || v === undefined) return null;
                  if (typeof v === "object") return JSON.stringify(v);
                  return v;
                });
                const allVals = [...whereValues, ...patchVals];
                const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
                const sql = `UPDATE public.${table} SET ${setClauses.join(", ")} ${whereSql} RETURNING ${selectedCols}`;
                const res = await client.query(sql, allVals);
                resolve({ data: res.rows, error: null });
              } catch (err) {
                reject(err);
              }
            },
          };
          return updateBuilder;
        },

        async upsert(rows, opts = {}) {
          if (!rows || rows.length === 0) return { data: [], error: null };
          const rowList = Array.isArray(rows) ? rows : [rows];
          const cols = Object.keys(rowList[0]);

          const valueRows = [];
          const allVals = [];
          for (const row of rowList) {
            const placeholders = [];
            for (const col of cols) {
              const val = row[col];
              allVals.push(val !== null && typeof val === "object" ? JSON.stringify(val) : val);
              placeholders.push(`$${allVals.length}`);
            }
            valueRows.push(`(${placeholders.join(", ")})`);
          }

          let onConflictSql = "";
          if (opts.ignoreDuplicates) {
            onConflictSql = `ON CONFLICT (${opts.onConflict || "id"}) DO NOTHING`;
          } else if (opts.onConflict) {
            const conflictCols = opts.onConflict.split(",").map((c) => c.trim());
            const updateCols = cols.filter((c) => !conflictCols.includes(c));
            if (updateCols.length > 0) {
              onConflictSql = `ON CONFLICT (${opts.onConflict}) DO UPDATE SET ${updateCols
                .map((c) => `${c} = EXCLUDED.${c}`)
                .join(", ")}`;
            } else {
              onConflictSql = `ON CONFLICT (${opts.onConflict}) DO NOTHING`;
            }
          }

          const sql = `INSERT INTO public.${table} (${cols.join(", ")}) VALUES ${valueRows.join(", ")} ${onConflictSql} RETURNING *`;
          const res = await client.query(sql, allVals);
          return { data: res.rows, error: null };
        },

        async then(resolve, reject) {
          try {
            if (isCountOnly) {
              const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
              const sql = `SELECT count(*)::integer AS cnt FROM public.${table} ${whereSql}`;
              const res = await client.query(sql, whereValues);
              resolve({ count: res.rows[0]?.cnt ?? 0, error: null });
              return;
            }

            const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
            const orderSql = orderCol ? `ORDER BY ${orderCol} ${orderAsc ? "ASC" : "DESC"}` : "";
            const limitSql = limitCount !== null ? `LIMIT ${limitCount}` : "";
            const sql = `SELECT ${selectedCols} FROM public.${table} ${whereSql} ${orderSql} ${limitSql}`;
            const res = await client.query(sql, whereValues);
            resolve({ data: res.rows, error: null });
          } catch (err) {
            reject(err);
          }
        },
      };

      return builder;
    },
  };
}

async function createUser(emailPrefix) {
  const userId = id();
  await query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())", [
    userId,
    `${emailPrefix}-${userId}@example.test`,
  ]);
  return userId;
}

async function createBrand(ownerUserId) {
  const brandKey = `qa-f18-${id()}.example`;
  await query(
    "INSERT INTO public.customer_brands (brand_key, display_name, website, website_host, is_active) VALUES ($1, $1, $2, $2, true)",
    [brandKey, `https://${brandKey}`]
  );
  if (ownerUserId) {
    await query(
      "INSERT INTO public.customer_brand_memberships (user_id, brand_key, role) VALUES ($1, $2, 'owner')",
      [ownerUserId, brandKey]
    );
  }
  return brandKey;
}

async function asUser(userId, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

async function main() {
  await apply125And126();

  const userA = await createUser("usera");
  const userB = await createUser("userb");
  const brandA = await createBrand(userA);
  const brandB = await createBrand(userB);

  const pgAdapter = createPgAdminAdapter(pool);
  const sqlStore = createSqlAuditStore(pgAdapter, { linkBudget: 10 });
  const memStore = createMemoryAuditStore({ linkBudget: 10 });

  console.log("Running Store Parity Tests (SQL vs Memory)...");
  const auditId = id();
  const startUrl = `https://${brandA}/`;

  // Seed audit in SQL & Memory
  const auditRow = {
    id: auditId,
    brand_key: brandA,
    job_id: id(),
    status: "running",
    current_phase: "crawling",
    requested_url: startUrl,
    start_url: startUrl,
    start_host: brandA,
    max_pages: 50,
    run_lighthouse: false,
    render_javascript: false,
    site_platform: null,
    robots_status: "found",
    robots_txt: "User-agent: *\nAllow: /",
    window_hint: 2,
    throttle_state: null,
    render_hold_id: null,
    render_approved_usd: null,
    render_attempts: 0,
    render_billed: 0,
    render_settled_at: null,
    lighthouse_approved_usd: null,
    pages_crawled: 0,
    pages_total: 50,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };

  await query(
    `INSERT INTO public.site_audits (id, brand_key, job_id, status, current_phase, requested_url, start_url, start_host, max_pages)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [auditId, brandA, auditRow.job_id, auditRow.status, auditRow.current_phase, auditRow.requested_url, auditRow.start_url, auditRow.start_host, auditRow.max_pages]
  );
  memStore.seedAudit(auditRow);

  // 1. seedStart
  await sqlStore.seedStart(auditId, startUrl);
  await memStore.seedStart(auditId, startUrl);

  // 2. seedSitemap
  const sitemapUrl = `https://${brandA}/page1`;
  await sqlStore.seedSitemap(auditId, [sitemapUrl]);
  await memStore.seedSitemap(auditId, [sitemapUrl]);

  // 3. stats match
  const sqlStats1 = await sqlStore.stats(auditId);
  const memStats1 = await memStore.stats(auditId);
  assert.deepEqual(sqlStats1, memStats1, "Stats match after seed");

  // 4. claimChunk
  const sqlClaim1 = await sqlStore.claimChunk(auditId, 1, 10);
  const memClaim1 = await memStore.claimChunk(auditId, 1, 10);
  assert.deepEqual(sqlClaim1, memClaim1, "First claim matches");

  // 5. claim retry
  const sqlClaimRetry = await sqlStore.claimChunk(auditId, 1, 10);
  const memClaimRetry = await memStore.claimChunk(auditId, 1, 10);
  assert.deepEqual(sqlClaimRetry, memClaimRetry, "Retry claim matches");
  assert.equal(sqlClaimRetry.isRetry, true);

  // 6. recordBatch
  const page1Id = id();
  const page2Id = id();
  const goneUrl = `https://${brandA}/gone`;
  const discoveredUrl = `https://${brandA}/discovered`;

  const sqlBatchStats = await sqlStore.recordBatch(auditId, {
    crawledUrls: [startUrl, sitemapUrl],
    links: [
      { pageId: page1Id, url: startUrl, targets: [goneUrl, sitemapUrl] },
      { pageId: page2Id, url: sitemapUrl, targets: [goneUrl] },
    ],
    discovered: [{ url: discoveredUrl, depth: 1 }],
  });
  const memBatchStats = await memStore.recordBatch(auditId, {
    crawledUrls: [startUrl, sitemapUrl],
    links: [
      { pageId: page1Id, url: startUrl, targets: [goneUrl, sitemapUrl] },
      { pageId: page2Id, url: sitemapUrl, targets: [goneUrl] },
    ],
    discovered: [{ url: discoveredUrl, depth: 1 }],
  });
  assert.deepEqual(sqlBatchStats, memBatchStats, "Batch stats match");

  // 7. upsertPages (including a 404 page for broken link testing)
  const pages = [
    {
      id: page1Id,
      url: startUrl,
      statusCode: 200,
      fetchClass: "ok",
      redirectUrl: null,
      title: "Start Page",
      metaDescription: "Home",
      canonicalUrl: null,
      robotsMeta: null,
      xRobotsTag: null,
      headerCanonicalUrl: null,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      h1Count: 1,
      h2Count: 0,
      h3Count: 0,
      h4Count: 0,
      h5Count: 0,
      h6Count: 0,
      headingOrder: [1],
      wordCount: 150,
      contentHash: "h1",
      isHtml: true,
      htmlBytes: 500,
      rateLimited: false,
      imagesTotal: 0,
      imagesMissingAlt: 0,
      images: [],
      links: [],
      hasStructuredData: false,
      hreflangTags: [],
      hreflang: [],
      structuredData: { blocks: [], missingType: 0, missingRequired: [], claimsNotVisible: [] },
      structuredDataTypes: [],
      dataNosnippet: false,
      rendered: false,
      isIndexable: true,
      responseTimeMs: 80,
      crawlDepth: 0,
      inSitemap: true,
    },
    {
      id: id(),
      url: goneUrl,
      statusCode: 404,
      fetchClass: "ok",
      redirectUrl: null,
      title: "Not Found",
      metaDescription: "",
      canonicalUrl: null,
      robotsMeta: null,
      xRobotsTag: null,
      headerCanonicalUrl: null,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      h1Count: 1,
      h2Count: 0,
      h3Count: 0,
      h4Count: 0,
      h5Count: 0,
      h6Count: 0,
      headingOrder: [1],
      wordCount: 10,
      contentHash: "h2",
      isHtml: true,
      htmlBytes: 200,
      rateLimited: false,
      imagesTotal: 0,
      imagesMissingAlt: 0,
      images: [],
      links: [],
      hasStructuredData: false,
      hreflangTags: [],
      hreflang: [],
      structuredData: { blocks: [], missingType: 0, missingRequired: [], claimsNotVisible: [] },
      structuredDataTypes: [],
      dataNosnippet: false,
      rendered: false,
      isIndexable: false,
      responseTimeMs: 50,
      crawlDepth: 1,
      inSitemap: false,
    },
  ];

  await sqlStore.upsertPages({ id: auditId, brandKey: brandA }, pages);
  await memStore.upsertPages({ id: auditId, brandKey: brandA }, pages);

  // 8. brokenLinks match
  const sqlBroken = await sqlStore.brokenLinks(auditId, 100);
  const memBroken = await memStore.brokenLinks(auditId, 100);
  assert.equal(sqlBroken.length, 2);
  assert.deepEqual(sqlBroken, memBroken, "Broken links match");

  // 9. orphanPages match
  const sqlOrphans = await sqlStore.orphanPages(auditId, startUrl);
  const memOrphans = await memStore.orphanPages(auditId, startUrl);
  assert.deepEqual(sqlOrphans, memOrphans, "Orphan pages match");

  // 10. abandonChunk
  const sqlAbandon = await sqlStore.abandonChunk(auditId, 1);
  const memAbandon = await memStore.abandonChunk(auditId, 1);
  assert.deepEqual(sqlAbandon, memAbandon, "Abandon chunk matches");

  // 11. destroyScratch
  await sqlStore.destroyScratch(auditId);
  await memStore.destroyScratch(auditId);
  const sqlStatsAfter = await sqlStore.stats(auditId);
  const memStatsAfter = await memStore.stats(auditId);
  assert.deepEqual(sqlStatsAfter, { attempted: 0, pending: 0, abandoned: 0, seen: 0 });
  assert.deepEqual(sqlStatsAfter, memStatsAfter, "Scratch destroyed in both");

  console.log("PASS store parity");

  // --- Group: site_audit_create concurrency and limits ---
  console.log("Running site_audit_create race & limits tests...");
  const raceMonthStart = new Date(Date.UTC(2026, 9, 1)).toISOString();

  // 1. Concurrent creates for the same workspace
  const create1Id = id();
  const create2Id = id();
  const [res1, res2] = await Promise.all([
    query(
      `SELECT public.site_audit_create($1, $2, $3, 'manual', $4, $4, $5, 50, false, false, $6, 50000, 2) AS res`,
      [create1Id, brandA, userA, `https://${brandA}/`, brandA, raceMonthStart]
    ),
    query(
      `SELECT public.site_audit_create($1, $2, $3, 'manual', $4, $4, $5, 50, false, false, $6, 50000, 2) AS res`,
      [create2Id, brandA, userA, `https://${brandA}/`, brandA, raceMonthStart]
    ),
  ]);

  const out1 = res1.rows[0].res;
  const out2 = res2.rows[0].res;
  const createdCount = (out1.created ? 1 : 0) + (out2.created ? 1 : 0);
  const failedOne = out1.created ? out2 : out1;
  assert.equal(createdCount, 1, "Exactly one concurrent create succeeds");
  assert.equal(failedOne.reason, "audit_already_running", "Second create receives audit_already_running");

  // 2. Host cap
  const sharedHost = "multi-tenant-host.test";
  const brandC = await createBrand(userA);
  const brandD = await createBrand(userB);
  const brandE = await createBrand(userA);

  const h1 = await query(
    `SELECT public.site_audit_create($1, $2, $3, 'manual', $4, $4, $5, 50, false, false, $6, 50000, 2) AS res`,
    [id(), brandC, userA, `https://${sharedHost}/`, sharedHost, raceMonthStart]
  );
  const h2 = await query(
    `SELECT public.site_audit_create($1, $2, $3, 'manual', $4, $4, $5, 50, false, false, $6, 50000, 2) AS res`,
    [id(), brandD, userB, `https://${sharedHost}/`, sharedHost, raceMonthStart]
  );
  assert.equal(h1.rows[0].res.created, true);
  assert.equal(h2.rows[0].res.created, true);

  const h3 = await query(
    `SELECT public.site_audit_create($1, $2, $3, 'manual', $4, $4, $5, 50, false, false, $6, 50000, 2) AS res`,
    [id(), brandE, userA, `https://${sharedHost}/`, sharedHost, raceMonthStart]
  );
  assert.equal(h3.rows[0].res.created, false);
  assert.equal(h3.rows[0].res.reason, "host_busy", "Third workspace on same host receives host_busy");

  // 3. Monthly cap
  const brandCap = await createBrand(userA);
  const capRes = await query(
    `SELECT public.site_audit_create($1, $2, $3, 'manual', $4, $4, $5, 100, false, false, $6, 50, 2) AS res`,
    [id(), brandCap, userA, `https://${brandCap}/`, brandCap, raceMonthStart]
  );
  assert.equal(capRes.rows[0].res.created, false);
  assert.equal(capRes.rows[0].res.reason, "audit_capacity_reached", "Capacity limit enforced");

  console.log("PASS site_audit_create limits");

  // --- Group: RLS ---
  console.log("Running RLS tests...");
  const rlsAuditAId = id();
  const rlsAuditBId = id();

  await query(
    `INSERT INTO public.site_audits (id, brand_key, requested_url, start_url, start_host, max_pages) VALUES ($1, $2, $3, $3, $2, 50)`,
    [rlsAuditAId, brandA, `https://${brandA}/`]
  );
  await query(
    `INSERT INTO public.site_audits (id, brand_key, requested_url, start_url, start_host, max_pages) VALUES ($1, $2, $3, $3, $2, 50)`,
    [rlsAuditBId, brandB, `https://${brandB}/`]
  );

  // Authenticated userA reads through RLS
  await asUser(userA, async (c) => {
    const audits = (await c.query("SELECT id, brand_key FROM public.site_audits")).rows;
    assert.ok(audits.some((a) => a.id === rlsAuditAId), "userA can see brandA audit");
    assert.ok(!audits.some((a) => a.id === rlsAuditBId), "userA cannot see brandB audit");

    // Scratch tables return permission denied
    let deniedFrontier = false;
    try {
      await c.query("SELECT * FROM public.site_audit_frontier");
    } catch (err) {
      deniedFrontier = err.code === "42501";
    }
    assert.ok(deniedFrontier, "site_audit_frontier denied for authenticated");

    let deniedLinks = false;
    try {
      await c.query("SELECT * FROM public.site_audit_links");
    } catch (err) {
      deniedLinks = err.code === "42501";
    }
    assert.ok(deniedLinks, "site_audit_links denied for authenticated");
  });

  console.log("PASS RLS");

  // --- Group: Retention ---
  console.log("Running retention tests...");
  const oldAuditId = id();
  const recentAuditId = id();
  const runningAuditId = id();
  const now = new Date();
  const daysAgo400 = new Date(now.getTime() - 400 * 24 * 3600 * 1000).toISOString();
  const daysAgo10 = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString();
  const daysAgo2 = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();

  // Old audit (completed 400 days ago, created 400 days ago)
  await query(
    `INSERT INTO public.site_audits (id, brand_key, requested_url, start_url, start_host, max_pages, status, created_at, completed_at)
     VALUES ($1, $2, $3, $3, $2, 50, 'completed', $4, $4)`,
    [oldAuditId, brandA, `https://${brandA}/old`, daysAgo400]
  );
  await query(
    `INSERT INTO public.site_audit_frontier (audit_id, url, depth, source) VALUES ($1, $2, 0, 'link')`,
    [oldAuditId, `https://${brandA}/old`]
  );

  // Recent finished audit (completed 2 days ago)
  await query(
    `INSERT INTO public.site_audits (id, brand_key, requested_url, start_url, start_host, max_pages, status, created_at, completed_at)
     VALUES ($1, $2, $3, $3, $2, 50, 'completed', $4, $4)`,
    [recentAuditId, brandA, `https://${brandA}/recent`, daysAgo2]
  );
  await query(
    `INSERT INTO public.site_audit_frontier (audit_id, url, depth, source) VALUES ($1, $2, 0, 'link')`,
    [recentAuditId, `https://${brandA}/recent`]
  );

  // Running audit
  await query(
    `INSERT INTO public.site_audits (id, brand_key, requested_url, start_url, start_host, max_pages, status, created_at)
     VALUES ($1, $2, $3, $3, $2, 50, 'running', $4)`,
    [runningAuditId, brandA, `https://${brandA}/running`, daysAgo10]
  );
  await query(
    `INSERT INTO public.site_audit_frontier (audit_id, url, depth, source) VALUES ($1, $2, 0, 'link')`,
    [runningAuditId, `https://${brandA}/running`]
  );

  // Prune: audits older than 395 days, scratch finished older than 7 days
  const pruneBeforeAudits = new Date(now.getTime() - 395 * 24 * 3600 * 1000).toISOString();
  const pruneBeforeScratch = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  const pruneRes = await query(
    `SELECT * FROM public.prune_site_audits($1, $2, 200)`,
    [pruneBeforeAudits, pruneBeforeScratch]
  );
  assert.ok(pruneRes.rows.some((r) => r.audit_id === oldAuditId), "Old audit returned by prune");

  const oldAuditRemains = (await query(`SELECT 1 FROM public.site_audits WHERE id = $1`, [oldAuditId])).rows;
  assert.equal(oldAuditRemains.length, 0, "Old audit deleted");

  const oldScratchRemains = (await query(`SELECT 1 FROM public.site_audit_frontier WHERE audit_id = $1`, [oldAuditId])).rows;
  assert.equal(oldScratchRemains.length, 0, "Old scratch deleted");

  const recentScratchRemains = (await query(`SELECT 1 FROM public.site_audit_frontier WHERE audit_id = $1`, [recentAuditId])).rows;
  assert.equal(recentScratchRemains.length, 1, "Recent finished scratch kept");

  const runningScratchRemains = (await query(`SELECT 1 FROM public.site_audit_frontier WHERE audit_id = $1`, [runningAuditId])).rows;
  assert.equal(runningScratchRemains.length, 1, "Running scratch kept");

  console.log("PASS retention");

  console.log("F18 DB checks: all passed");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
