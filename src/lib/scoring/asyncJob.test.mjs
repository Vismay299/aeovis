import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanJob, getScanJob, updateScanJob } from '../db.js';

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
  });
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
  const fetched = await getScanJob(job.id);
  assert.deepEqual(fetched, job);

  // 3. Update status (generating_prompts)
  const updated1 = await updateScanJob(job.id, { status: "generating_prompts", progress_pct: 10 });
  assert.equal(updated1.status, "generating_prompts");
  assert.equal(updated1.progress_pct, 10);

  // 4. Update status (probing)
  const updated2 = await updateScanJob(job.id, { status: "probing", progress_pct: 50 });
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
  });

  assert.equal(completed.status, "complete");
  assert.equal(completed.progress_pct, 100);
  assert.equal(completed.result_id, "result-123");
  assert.deepEqual(completed.run_record, mockRecord);

  // 6. Verify final fetch contains snapshot data
  const finalFetched = await getScanJob(job.id);
  assert.equal(finalFetched.status, "complete");
  assert.deepEqual(finalFetched.run_record, mockRecord);
});
