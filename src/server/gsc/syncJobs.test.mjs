import test from "node:test";
import assert from "node:assert/strict";
import { processGscSyncJob } from "./syncJobs.js";

const job = { id: "job-a", checkpoint_page: 5000, window_start_date: "2026-07-01", window_end_date: "2026-09-28" };
const connection = { brand: "workspace-a", brand_key: "workspace-a", site_url: "sc-domain:example.test", auth_mode: "oauth", connection_generation: 2 };

test("truncated sync resumes its saved offset and stays pending until Google finishes", async () => {
  const calls = [];
  const admin = { rpc: async (name, args) => { calls.push({ name, args }); return { data: 1 }; } };
  const fetchRows = async (_site, options, credentials) => {
    assert.equal(options.startRow, 5000);
    assert.equal(options.maxPages, 1);
    assert.equal(options.startDate, "2026-07-01");
    assert.equal(credentials.brandKey, "workspace-a");
    return { rows: [{ date: "2026-09-01", query: "q", clicks: 1 }], truncated: true, nextStartRow: 10000 };
  };
  const result = await processGscSyncJob(job, connection, { admin, workerId: "worker", fetchRows });
  assert.equal(result.status, "pending");
  assert.equal(calls[0].name, "commit_customer_gsc_page");
  assert.equal(calls[0].args.p_complete, false);
  assert.equal(calls[0].args.p_next_page, 10000);
  assert.equal(calls[0].args.p_rows[0].brand_key, "workspace-a");
});

test("only a fully read page completes; failed or stale writes never report success", async () => {
  const fetchRows = async () => ({ rows: [], truncated: false });
  const admin = { rpc: async (_name, args) => { assert.equal(args.p_complete, true); return { data: 0 }; } };
  assert.equal((await processGscSyncJob(job, connection, { admin, workerId: "worker", fetchRows })).status, "completed");
  await assert.rejects(processGscSyncJob(job, connection, {
    admin: { rpc: async () => ({ error: { message: "generation changed" } }) }, workerId: "worker", fetchRows,
  }), /Could not commit/);
  await assert.rejects(processGscSyncJob(job, connection, {
    admin, workerId: "worker", fetchRows: async () => ({ rows: [], truncated: true, nextStartRow: 5000 }),
  }), /did not advance/);
});
