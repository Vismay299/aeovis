import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanJob, getScanJob, updateScanJob } from '../../server/db.js';

/**
 * R3.2.4 — `{ client: null }` is db.js's own test-only injection
 * (`resolveClient`), and it is what makes this case exercise the in-memory job
 * lifecycle it claims to test.
 *
 * Without it, `createScanJob` resolves db.js's module-level client and inserted
 * a row into the production `scan_jobs` table whenever
 * NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY happened to be set — which is what
 * src/server/liveDbGate.js tells live-test authors to do. The memory path was not
 * chosen here; it was the accident of an unset shell variable. It is chosen
 * now, once, in one place.
 */
const MEMORY_ONLY = { client: null };

test('Scan Jobs - lifecycle state updates and persistence', async () => {
  const brand = "TestBrand";
  const url = "test.com";
  const industry = "saas";
  const competitors = "CompA, CompB";

  // 1. Create job
  const job = await createScanJob({
    brand,
    url,
    industry,
    competitors,
  }, MEMORY_ONLY);
  assert.ok(job.id);
  assert.equal(job.brand, brand);
  assert.equal(job.url, url);
  assert.equal(job.industry, industry);
  assert.equal(job.competitors, competitors);
  assert.equal(job.query_source, "hybrid");
  assert.deepEqual(job.gsc_queries, []);
  assert.equal(job.status, "pending");
  assert.equal(job.progress_pct, 0);

  // 2. Retrieve job
  const fetched = await getScanJob(job.id, MEMORY_ONLY);
  assert.deepEqual(fetched, job);

  // 3. Update status (generating_prompts)
  const updated1 = await updateScanJob(job.id, { status: "generating_prompts", progress_pct: 10 }, MEMORY_ONLY);
  assert.equal(updated1.status, "generating_prompts");
  assert.equal(updated1.progress_pct, 10);

  // 4. Update status (probing)
  const updated2 = await updateScanJob(job.id, { status: "probing", progress_pct: 50 }, MEMORY_ONLY);
  assert.equal(updated2.status, "probing");
  assert.equal(updated2.progress_pct, 50);

  // 5. Complete job with run record snapshot
  const mockRecord = {
    brand,
    url,
    visibility_pct: 85.5,
    scoring_version: "v6-bayesian"
  };
  const completed = await updateScanJob(job.id, {
    status: "complete",
    progress_pct: 100,
    result_id: "result-123",
    run_record: mockRecord
  }, MEMORY_ONLY);

  assert.equal(completed.status, "complete");
  assert.equal(completed.progress_pct, 100);
  assert.equal(completed.result_id, "result-123");
  assert.deepEqual(completed.run_record, mockRecord);

  // 6. Verify final fetch contains snapshot data
  const finalFetched = await getScanJob(job.id, MEMORY_ONLY);
  assert.equal(finalFetched.status, "complete");
  assert.deepEqual(finalFetched.run_record, mockRecord);
});
