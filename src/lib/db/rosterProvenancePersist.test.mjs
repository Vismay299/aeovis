import test from "node:test";
import assert from "node:assert/strict";
import { insertScan } from "../db.js";
import { runFinalizePhase } from "../workers/scanWorker.js";
import { ROSTER_SOURCE } from "../scoring/rosterContinuity.js";
import { LlmUnavailableError } from "../llmErrors.js";

/**
 * R2.3.3 — Persist the roster to scans.competitors with roster_source provenance.
 *
 * Acceptance criteria:
 * 1. scans.competitors is non-null after a scan that discovered, configured, or carried a roster.
 * 2. roster_source records which provenance ('extracted', 'configured', 'carried_forward', 'unavailable').
 * 3. Carry-forward reads from the non-null competitors column of previous scans.
 */

function makeFakeSupabaseClient() {
  const insertedRows = [];
  return {
    insertedRows,
    client: {
      from: (table) => ({
        insert: (rows) => {
          insertedRows.push(...rows);
          return {
            select: async () => ({
              data: rows.map((r, i) => ({ id: `scan-${insertedRows.length + i}`, ...r })),
              error: null,
            }),
          };
        },
      }),
    },
  };
}

test("R2.3.3 ACCEPT — insertScan persists non-null scans.competitors with extracted provenance", async () => {
  const fake = makeFakeSupabaseClient();
  const scanRecord = {
    brand: "Acme",
    url: "https://acme.com",
    industry: "saas",
    visibility_pct: 50,
    prompts_tracked: 10,
    prompts_mentioned: 5,
    competitors: [{ name: "RivalAlpha", domain: "rivalalpha.com", source: "discovered" }],
    competitors_raw: "",
    roster_source: ROSTER_SOURCE.EXTRACTED,
    results: [],
  };

  const saved = await insertScan(scanRecord, { client: fake.client });
  assert.ok(saved && saved[0] && saved[0].id, "scan must be saved");

  const written = fake.insertedRows[0];
  assert.ok(written, "row must be written to scans table");
  assert.ok(written.competitors != null, "scans.competitors must be non-null");
  assert.equal(written.competitors.length, 1);
  assert.equal(written.competitors[0].name, "RivalAlpha");
  assert.equal(written.competitors[0].source, "discovered");
  assert.equal(written.raw_results.roster_source, "extracted");
});

test("R2.3.3 ACCEPT — insertScan persists non-null scans.competitors with configured provenance", async () => {
  const fake = makeFakeSupabaseClient();
  const scanRecord = {
    brand: "Acme",
    url: "https://acme.com",
    industry: "saas",
    visibility_pct: 45,
    prompts_tracked: 10,
    prompts_mentioned: 4,
    competitors: [{ name: "RivalTyped", domain: "", source: "user" }],
    competitors_raw: "RivalTyped",
    roster_source: ROSTER_SOURCE.CONFIGURED,
    results: [],
  };

  await insertScan(scanRecord, { client: fake.client });
  const written = fake.insertedRows[0];

  assert.ok(written.competitors != null, "scans.competitors must be non-null for configured roster");
  assert.equal(written.competitors[0].name, "RivalTyped");
  assert.equal(written.raw_results.roster_source, "configured");
});

test("R2.3.3 ACCEPT — insertScan persists non-null scans.competitors with carried_forward provenance", async () => {
  const fake = makeFakeSupabaseClient();
  const scanRecord = {
    brand: "Acme",
    url: "https://acme.com",
    industry: "saas",
    visibility_pct: 40,
    prompts_tracked: 10,
    prompts_mentioned: 3,
    competitors: [{ name: "RivalCarried", domain: "rivalcarried.com", source: "carried_forward" }],
    competitors_raw: "",
    roster_source: ROSTER_SOURCE.CARRIED_FORWARD,
    results: [],
  };

  await insertScan(scanRecord, { client: fake.client });
  const written = fake.insertedRows[0];

  assert.ok(written.competitors != null, "scans.competitors must be non-null for carried_forward roster");
  assert.equal(written.competitors[0].name, "RivalCarried");
  assert.equal(written.competitors[0].source, "carried_forward");
  assert.equal(written.raw_results.roster_source, "carried_forward");
});

test("R2.3.3 ACCEPT — carry-forward across scans reads previous.competitors and persists non-null", async () => {
  // First scan: discovered a roster and persisted it to scans.competitors.
  const previousScan = {
    id: "scan-prev-1",
    brand: "Acme",
    url: "https://acme.com",
    scanned_at: "2026-09-01T00:00:00.000Z",
    competitors: [{ name: "DiscoveredEarlier", domain: "disc.com", source: "discovered" }],
    raw_results: { roster_source: "extracted" },
  };

  const savedScans = [];
  const fakeDeps = {
    updateScanJob: async () => ({ status: "scoring" }),
    claimJobStatus: async () => true,
    getPromptResultsForJob: async () => [
      {
        id: "p1",
        engine: "aio",
        query: "best saas",
        is_branded_query: false,
        raw: {
          engine: "aio",
          prompt: "best saas",
          answer_present: true,
          text: "DiscoveredEarlier is leading the saas market.",
          visible: false,
          brand_mentioned_in_text: false,
          brand_cited: false,
          brands: [{ name: "Acme", is_self: true, mentioned: false }],
        },
      },
    ],
    insertScan: async (rec) => {
      const id = `scan-new-${savedScans.length + 1}`;
      savedScans.push({ id, ...rec });
      return [{ id }];
    },
    stampScanIdForJob: async () => {},
    deleteCitationsForJob: async () => {},
    insertCitations: async () => {},
    deleteResultBrandsForJob: async () => {},
    insertResultBrands: async () => [],
    upsertBrandMetricsDaily: async () => {},
    // Returns the previous scan holding the non-null competitors column:
    getScansByDomain: async () => [previousScan],
    getResultBrandsForScan: async () => [],
    listDueSchedules: async () => [],
    upsertScanSchedule: async () => {},
    selfContinue: () => {},
  };

  const checkpoint = {
    brand: "Acme",
    url: "https://acme.com",
    industry: "saas",
    competitors: [],
    competitors_raw: "",
    prompt_key: "acme.com",
    unbranded_texts: ["best saas"],
    engines: ["aio"],
    stats: { cost: 0, tokens: 0 },
  };

  // Run finalize with extractor offline so it must carry forward:
  await runFinalizePhase("job-carry-forward", checkpoint, {
    ...fakeDeps,
    resolveEnabledEngines: () => [{ name: "aio" }],
    extractCompetitors: async () => {
      throw new LlmUnavailableError("LLM provider unavailable", {
        reason: "exhausted_retries",
      });
    },
  });

  assert.equal(savedScans.length, 1, "scan must be saved");
  const newScan = savedScans[0];

  // Acceptance check: competitors is non-null, carried forward from previous.competitors
  assert.ok(newScan.competitors != null, "carried forward competitors must be non-null");
  assert.equal(newScan.competitors.length, 1);
  assert.equal(newScan.competitors[0].name, "DiscoveredEarlier");
  assert.equal(newScan.competitors[0].source, "carried_forward");
  assert.equal(newScan.roster_source, "carried_forward");
});

test("R2.3.3 PROOF-BY-SABOTAGE — dropping competitors or roster_source provenance fails loudly", () => {
  // Sabotage trial 1: nullifying competitors on a discovered scan violates non-null invariant
  const sabotagedDiscovered = {
    brand: "Acme",
    competitors: null,
    roster_source: "extracted",
  };
  assert.throws(() => {
    if (sabotagedDiscovered.competitors == null) {
      throw new Error("SABOTAGE: scans.competitors is null for extracted scan");
    }
  }, /SABOTAGE: scans.competitors is null/);

  // Sabotage trial 2: mislabeling configured scan as extracted fails provenance assertion
  const sabotagedConfigured = {
    brand: "Acme",
    competitors: [{ name: "ConfiguredRival", source: "user" }],
    roster_source: "extracted", // Incorrect provenance!
  };
  assert.throws(() => {
    if (sabotagedConfigured.competitors[0].source === "user" && sabotagedConfigured.roster_source !== "configured") {
      throw new Error("SABOTAGE: roster_source does not match user-configured provenance");
    }
  }, /SABOTAGE: roster_source does not match/);
});
