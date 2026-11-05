import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { dispatchBudget, freezeDispatch, runDurableProbing } from "./durableProbing.js";
import { createScanJob } from "../db.js";

test("F09-AC-08 dispatchBudget resolves scanCap as min(SCAN_MAX_COST_PER_SCAN, approvedMaxUsd)", () => {
  // 1. Env cap lower than approved max
  const b1 = dispatchBudget({ SCAN_MAX_COST_PER_SCAN: "10" }, { approvedMaxUsd: 24 });
  assert.equal(b1.scanCap, 10);

  // 2. No env cap, approved max set
  const b2 = dispatchBudget({}, { approvedMaxUsd: 24 });
  assert.equal(b2.scanCap, 24);

  // 3. Env cap higher than approved max
  const b3 = dispatchBudget({ SCAN_MAX_COST_PER_SCAN: "30" }, { approvedMaxUsd: 24 });
  assert.equal(b3.scanCap, 24);

  // 4. Neither set
  const b4 = dispatchBudget({}, {});
  assert.equal(b4.scanCap, null);
});

test("F09-AC-08 runDurableProbing passes scanCap from checkpoint.approved_max_usd into store.claim", async () => {
  const env = {
    OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY",
  };
  const testWithApprovedCap = async (approvedMaxUsd) => {
    const rows = [];
    let recordedBudget = null;

    const checkpoint = {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["chatgpt"],
      queries: [{ text: "Fixture question?" }],
      stats: { cost: 0 },
      approved_max_usd: approvedMaxUsd,
      dispatch: freezeDispatch({ engines: ["chatgpt"], env }),
    };

    const store = {
      seed: async (values) => {
        rows.push(...values.map((r) => ({ ...r, state: "pending", attempt_count: 0, next_attempt_at: new Date().toISOString() })));
      },
      claim: async (id, budget) => {
        recordedBudget = budget;
        return { granted: false, reason: "spend_reservation_refused" };
      },
      list: async () => rows,
      block: async () => {},
    };

    await runDurableProbing({
      jobId: "fixture-job-" + crypto.randomUUID(),
      checkpoint,
      engines: [
        {
          name: "chatgpt",
          probe: async () => {},
        },
      ],
      store,
      getResults: async () => [],
      updateJob: async () => {},
      env,
      chunkStartMs: Date.now(),
      budgetMs: 150_000,
    });

    return recordedBudget?.scanCap ?? null;
  };

  // Checkpoint with approved_max_usd: 24
  const capWithApproval = await testWithApprovedCap(24);
  assert.equal(capWithApproval, 24);

  // Checkpoint without approved_max_usd
  const capWithoutApproval = await testWithApprovedCap(undefined);
  assert.equal(capWithoutApproval, null);
});

test("F09-AC-08 createScanJob in memory mode preserves custom jobId, approvedMaxUsd and priceQuote", async () => {
  const customJobId = crypto.randomUUID();
  const quoteFixture = {
    action: "ai_visibility.scan.run",
    totalUsd: 24,
    priceVersion: "2026-10-21.1",
  };

  const job = await createScanJob({
    brand: "Acme",
    url: "https://acme.example",
    brandKey: "workspace-acme",
    jobId: customJobId,
    approvedMaxUsd: 24,
    priceQuote: quoteFixture,
  });

  assert.equal(job.id, customJobId);
  assert.equal(job.approved_max_usd, 24);
  assert.deepEqual(job.price_quote, quoteFixture);

  // Verify memory map also stores the fields
  const stored = global.memoryJobs?.get(customJobId);
  assert.ok(stored);
  assert.equal(stored.id, customJobId);
  assert.equal(stored.approved_max_usd, 24);
  assert.deepEqual(stored.price_quote, quoteFixture);
});
