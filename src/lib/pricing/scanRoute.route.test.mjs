import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("../customerRoutes.test.hooks.mjs", import.meta.url);

const { POST } = await import("../../app/api/customer/scan/route.js");
const { DuplicateScanError } = await import("../duplicateScan.js");
const { SpendRefused } = await import("../spend/errors.ts");
const { formatUsd } = await import("../../shared/pricing.ts");

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/f09",
);
const panelFixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "panel-30.json"), "utf8"),
);
const quoteFixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, "quote-24.json"), "utf8"),
);

const USER = { id: "user-123", email: "member@example.test" };
const BRAND_KEY = "offcult.in";
const FIXED_JOB_ID = "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90";

function makeFakeAdmin() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  };
}

function makeDeps(overrides = {}) {
  const reserveCalls = [];
  const releaseCalls = [];
  const createJobCalls = [];
  const recordApprovalCalls = [];
  const runScanChunkCalls = [];

  const defaultRequireApprovedPrice = async (
    action,
    ctx,
    input,
    maxUsd,
  ) => {
    const quote = quoteFixture;
    if (maxUsd === undefined) {
      return { quote, approvedMaxUsd: quote.totalUsd, source: "implicit" };
    }
    if (maxUsd < quote.totalUsd) {
      const { AppError } = await import("../http/errors.ts");
      throw new AppError(
        409,
        "price_changed",
        `This now costs up to ${formatUsd(quote.totalUsd)}, more than the ${formatUsd(maxUsd)} you approved. Review the new price.`,
        {
          recovery: "Review the new price and approve it to continue.",
          details: { approvedMaxUsd: maxUsd, quote },
        },
      );
    }
    return { quote, approvedMaxUsd: maxUsd, source: "dialog" };
  };

  const deps = {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [
        {
          brandKey: BRAND_KEY,
          role: "member",
          display_name: "Offcult",
          website: "https://offcult.in",
          website_host: "offcult.in",
          aliases: [],
          is_active: true,
        },
      ],
      error: null,
    }),
    getSupabaseAdmin: () => makeFakeAdmin(),
    repairWorkflowStore: () => ({
      list: async (brandKey, artifactType) => {
        if (artifactType === "panel") {
          return [panelFixture];
        }
        return [];
      },
    }),
    randomUUID: () => FIXED_JOB_ID,
    requireApprovedPrice: defaultRequireApprovedPrice,
    reserveSpend: async (args) => {
      reserveCalls.push(args);
      return { holdId: "hold-test-uuid", existing: false };
    },
    releaseSpend: async (holdId, reason) => {
      releaseCalls.push({ holdId, reason });
      return { released: true };
    },
    createScanJob: async (args) => {
      createJobCalls.push(args);
      return { jobId: args.jobId };
    },
    recordApproval: async (admin, args) => {
      recordApprovalCalls.push(args);
      return "approval-row-uuid";
    },
    keepAlive: (fn) => fn(),
    runScanChunk: async (jobId) => {
      runScanChunkCalls.push(jobId);
    },
    ...overrides,
  };

  return {
    deps,
    reserveCalls,
    releaseCalls,
    createJobCalls,
    recordApprovalCalls,
    runScanChunkCalls,
  };
}

function makeRequest(body, headers = {}) {
  return new Request("https://app.test/api/customer/scan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "https://app.test",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(res) {
  const json = await res.json();
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    body: json,
  };
}

test("POST /api/customer/scan: price_changed returns 409 and creates no job, hold or approval", async () => {
  const h = makeDeps();
  const req = makeRequest({ brand_key: BRAND_KEY, maxUsd: 20 });
  const res = await read(await POST(req, h.deps));

  assert.equal(res.status, 409);
  assert.equal(res.cacheControl, "no-store");
  assert.equal(res.body.code, "price_changed");
  assert.equal(
    res.body.error,
    "This now costs up to $24.00, more than the $20.00 you approved. Review the new price.",
  );
  assert.equal(res.body.recovery, "Review the new price and approve it to continue.");
  assert.equal(res.body.details?.approvedMaxUsd, 20);
  assert.equal(res.body.details?.quote?.totalUsd, 24);

  assert.equal(h.reserveCalls.length, 0, "no spend hold reserved");
  assert.equal(h.createJobCalls.length, 0, "no scan job created");
  assert.equal(h.recordApprovalCalls.length, 0, "no approval row recorded");
});

test("POST /api/customer/scan: approved creates job, reserves spend hold, and records approval", async () => {
  const h = makeDeps();
  const req = makeRequest({ brand_key: BRAND_KEY, maxUsd: 25 });
  const res = await read(await POST(req, h.deps));

  assert.equal(res.status, 201);
  assert.equal(res.cacheControl, "no-store");
  assert.equal(res.body.job_id, FIXED_JOB_ID);
  assert.equal(res.body.brand, "Offcult");
  assert.equal(res.body.status, "pending");
  assert.equal(res.body.approvedMaxUsd, 25);
  assert.equal(res.body.quotedUsd, 24);

  // Exact hold args (F09-AC-05)
  assert.equal(h.reserveCalls.length, 1);
  assert.deepEqual(h.reserveCalls[0], {
    brandKey: BRAND_KEY,
    feature: "ai_visibility.scan",
    estimateUsd: 24,
    maxUsd: 25,
    idempotencyKey: `scan:${FIXED_JOB_ID}`,
    ttlSeconds: 86340,
    subject: { kind: "scan_job", id: FIXED_JOB_ID },
  });

  // Exact job args
  assert.equal(h.createJobCalls.length, 1);
  assert.equal(h.createJobCalls[0].brandKey, BRAND_KEY);
  assert.equal(h.createJobCalls[0].brand, "Offcult");
  assert.equal(h.createJobCalls[0].url, "https://offcult.in");
  assert.equal(h.createJobCalls[0].jobId, FIXED_JOB_ID);
  assert.equal(h.createJobCalls[0].approvedMaxUsd, 25);
  assert.deepEqual(h.createJobCalls[0].priceQuote, quoteFixture);
  assert.deepEqual(h.createJobCalls[0].panelSnapshot, panelFixture);
  assert.deepEqual(h.createJobCalls[0].measurementContext, panelFixture.payload.context);

  // Exact approval record args
  assert.equal(h.recordApprovalCalls.length, 1);
  assert.deepEqual(h.recordApprovalCalls[0], {
    brandKey: BRAND_KEY,
    action: "ai_visibility.scan.run",
    approvedMaxUsd: 25,
    quote: quoteFixture,
    source: "dialog",
    subject: { kind: "scan_job", id: FIXED_JOB_ID },
    approvedBy: USER.id,
  });

  assert.deepEqual(h.runScanChunkCalls, [FIXED_JOB_ID]);
});

test("POST /api/customer/scan: implicit (no maxUsd) caps scan at quote and records implicit approval", async () => {
  const h = makeDeps();
  const req = makeRequest({ brand_key: BRAND_KEY });
  const res = await read(await POST(req, h.deps));

  assert.equal(res.status, 201);
  assert.equal(res.body.job_id, FIXED_JOB_ID);
  assert.equal(res.body.approvedMaxUsd, 24);
  assert.equal(res.body.quotedUsd, 24);

  assert.equal(h.reserveCalls[0].maxUsd, 24);
  assert.equal(h.createJobCalls[0].approvedMaxUsd, 24);
  assert.equal(h.recordApprovalCalls[0].source, "implicit");
  assert.equal(h.recordApprovalCalls[0].approvedMaxUsd, 24);
});

test("POST /api/customer/scan: F01 refusals from reserveSpend create no scan job", async () => {
  const refusals = [
    { reason: "daily_cap", expectedStatus: 402 },
    { reason: "workspace_cap", expectedStatus: 402 },
    { reason: "feature_disabled", expectedStatus: 403 },
  ];

  for (const { reason, expectedStatus } of refusals) {
    const h = makeDeps({
      reserveSpend: async () => {
        throw new SpendRefused(reason);
      },
    });

    const req = makeRequest({ brand_key: BRAND_KEY, maxUsd: 25 });
    const res = await read(await POST(req, h.deps));

    assert.equal(res.status, expectedStatus, `status for ${reason}`);
    assert.equal(res.body.code, reason, `code for ${reason}`);
    assert.equal(h.createJobCalls.length, 0, `no job created for ${reason}`);
  }
});

test("POST /api/customer/scan: DuplicateScanError releases hold with scan_already_running and returns 409", async () => {
  const h = makeDeps({
    createScanJob: async () => {
      throw new DuplicateScanError("scan already running");
    },
  });

  const req = makeRequest({ brand_key: BRAND_KEY, maxUsd: 25 });
  const res = await read(await POST(req, h.deps));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "scan_already_running");
  assert.equal(res.body.error, "A scan is already running for this workspace.");

  assert.equal(h.releaseCalls.length, 1);
  assert.deepEqual(h.releaseCalls[0], {
    holdId: "hold-test-uuid",
    reason: "scan_already_running",
  });
});

test("POST /api/customer/scan: generic job create failure releases hold with scan_create_failed and returns 500", async () => {
  const h = makeDeps({
    createScanJob: async () => {
      throw new Error("DB connection dropped");
    },
  });

  const req = makeRequest({ brand_key: BRAND_KEY, maxUsd: 25 });
  const res = await read(await POST(req, h.deps));

  assert.equal(res.status, 500);
  assert.equal(res.body.code, "internal_error");
  assert.equal(res.body.error, "Could not start the scan. Please retry.");

  assert.equal(h.releaseCalls.length, 1);
  assert.deepEqual(h.releaseCalls[0], {
    holdId: "hold-test-uuid",
    reason: "scan_create_failed",
  });
});

test("POST /api/customer/scan: approval record failure is logged and does not fail the scan (returns 201)", async () => {
  const originalError = console.error;
  let loggedError = null;
  console.error = (...args) => {
    loggedError = args.join(" ");
  };

  try {
    const h = makeDeps({
      recordApproval: async () => {
        throw new Error("approvals DB table locked");
      },
    });

    const req = makeRequest({ brand_key: BRAND_KEY, maxUsd: 25 });
    const res = await read(await POST(req, h.deps));

    assert.equal(res.status, 201);
    assert.equal(res.body.job_id, FIXED_JOB_ID);
    assert.equal(res.body.status, "pending");
    assert.match(loggedError || "", /\[pricing\] approval record failed/);
  } finally {
    console.error = originalError;
  }
});
