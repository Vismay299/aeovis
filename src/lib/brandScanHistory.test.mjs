import test from "node:test";
import assert from "node:assert/strict";
import {
  joinScanIdentities,
  getContinuousScanHistory,
  getScansForBrand,
  ScansUnavailableError,
} from "./db.js";
import { runSchedulerTick } from "./workers/scanWorker.js";

// ---------------------------------------------------------------------------
// R3.4.3: display_name written so scheduled and manual scans share one identity
// Detail: Scheduled scans key by domain and manual scans by display name,
//         splitting a brand's history in two.
// Accept: A brand scanned both ways has one continuous history; a test covers the join.
// ---------------------------------------------------------------------------

const MANUAL_SCAN_1 = {
  id: "scan-m-1",
  brand: "Italica",
  url: "https://italicatiles.com",
  scanned_at: "2026-08-01T12:00:00.000Z",
  visibility_pct: 40,
  raw_results: { results: [{ query: "luxury floor tiles", is_gap: false }] },
};

const SCHEDULED_SCAN_1 = {
  id: "scan-s-1",
  brand: "italicatiles.com",
  url: "italicatiles.com",
  scanned_at: "2026-08-05T12:00:00.000Z",
  visibility_pct: 45,
  raw_results: { results: [{ query: "ceramic tile dealers", is_gap: true }] },
};

const MANUAL_SCAN_2 = {
  id: "scan-m-2",
  brand: "Italica",
  url: "https://italicatiles.com/products",
  scanned_at: "2026-08-10T12:00:00.000Z",
  visibility_pct: 50,
  raw_results: { results: [{ query: "best vitrified tiles", is_gap: false }] },
};

// ---------------------------------------------------------------------------
// 1. Pure joinScanIdentities behavior
// ---------------------------------------------------------------------------

test("R3.4.3 — joinScanIdentities: merges brand and domain scans into one continuous history (newest first)", () => {
  const brandScans = [MANUAL_SCAN_2, MANUAL_SCAN_1];
  const domainScans = [SCHEDULED_SCAN_1];

  const joined = joinScanIdentities(brandScans, domainScans);

  assert.equal(joined.length, 3, "all 3 scans from both identities are present");
  assert.deepEqual(
    joined.map((s) => s.id),
    ["scan-m-2", "scan-s-1", "scan-m-1"],
    "continuous chronological order (newest first: Aug 10, Aug 5, Aug 1)"
  );
});

test("R3.4.3 — joinScanIdentities: deduplicates overlapping scans by id", () => {
  const brandScans = [MANUAL_SCAN_1];
  const domainScans = [MANUAL_SCAN_1, SCHEDULED_SCAN_1];

  const joined = joinScanIdentities(brandScans, domainScans);

  assert.equal(joined.length, 2, "duplicate scan-m-1 is deduplicated");
  assert.deepEqual(
    joined.map((s) => s.id),
    ["scan-s-1", "scan-m-1"]
  );
});

test("R3.4.3 — joinScanIdentities: handles empty arrays and falsy inputs cleanly", () => {
  assert.deepEqual(joinScanIdentities([], []), []);
  assert.deepEqual(joinScanIdentities(null, undefined), []);
  assert.deepEqual(joinScanIdentities([MANUAL_SCAN_1], null), [MANUAL_SCAN_1]);
});

// ---------------------------------------------------------------------------
// 2. getContinuousScanHistory across both query representations
// ---------------------------------------------------------------------------

test("R3.4.3 — getContinuousScanHistory: querying by display name returns continuous history including scheduled scans", async () => {
  const fakeDeps = {
    getScansForBrand: async (brand) => {
      if (brand === "Italica") return [MANUAL_SCAN_2, MANUAL_SCAN_1];
      return [];
    },
    getScansByDomain: async (domain) => {
      if (domain === "italicatiles.com") return [SCHEDULED_SCAN_1];
      return [];
    },
  };

  const history = await getContinuousScanHistory("Italica", fakeDeps);

  assert.equal(history.length, 3, "returns all 3 scans across both identities");
  assert.deepEqual(
    history.map((s) => s.id),
    ["scan-m-2", "scan-s-1", "scan-m-1"],
    "ordered newest to oldest"
  );
  assert.ok(
    history.some((s) => s.brand === "Italica") && history.some((s) => s.brand === "italicatiles.com"),
    "history bridges both the display-name identity and domain identity"
  );
});

test("R3.4.3 — getContinuousScanHistory: querying by domain returns continuous history including manual scans", async () => {
  const fakeDeps = {
    getScansForBrand: async (brand) => {
      if (brand === "italicatiles.com") return [SCHEDULED_SCAN_1];
      return [];
    },
    getScansByDomain: async (domain) => {
      if (domain === "italicatiles.com") return [MANUAL_SCAN_2, SCHEDULED_SCAN_1, MANUAL_SCAN_1];
      return [];
    },
  };

  const history = await getContinuousScanHistory("italicatiles.com", fakeDeps);

  assert.equal(history.length, 3, "returns all 3 scans across both identities");
  assert.deepEqual(
    history.map((s) => s.id),
    ["scan-m-2", "scan-s-1", "scan-m-1"],
    "continuous chronological order"
  );
});

test("R3.4.3 — getContinuousScanHistory: empty/blank argument refuses with brand_required", async () => {
  await assert.rejects(
    () => getContinuousScanHistory("   "),
    (err) => err instanceof ScansUnavailableError && err.code === "brand_required"
  );
});

// ---------------------------------------------------------------------------
// 3. getScansForBrand join integration
// ---------------------------------------------------------------------------

test("R3.4.3 — getScansForBrand: joins domain scans from URL host when available", async () => {
  const fakeClient = {
    from(table) {
      if (table === "scans") {
        return {
          select() {
            return {
              ilike(col, val) {
                return {
                  order() {
                    if (val === "Italica") {
                      return Promise.resolve({ data: [MANUAL_SCAN_1], error: null });
                    }
                    return Promise.resolve({ data: [], error: null });
                  },
                };
              },
              order() {
                return {
                  limit() {
                    // getScansByDomain queries all scans up to 200
                    return Promise.resolve({
                      data: [MANUAL_SCAN_1, SCHEDULED_SCAN_1],
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  const result = await getScansForBrand("Italica", { client: fakeClient });
  assert.equal(result.length, 2, "joins manual and scheduled scans");
  assert.deepEqual(result.map((s) => s.id), ["scan-s-1", "scan-m-1"]);
});

// ---------------------------------------------------------------------------
// 4. runSchedulerTick writes display_name so scheduled and manual scans share one identity
// ---------------------------------------------------------------------------

test("R3.4.3 — runSchedulerTick: adopts display_name from previous scan and writes to scan_schedules", async () => {
  const scheduleWrites = [];
  const createdJobs = [];

  const dueSchedule = {
    brand: "italicatiles.com",
    display_name: null, // missing on the schedule row!
    cadence: "weekly",
    enabled: true,
    next_run_at: "2026-08-01T00:00:00.000Z",
  };

  const fakeDeps = {
    listDueSchedules: async () => [dueSchedule],
    hasActiveScanForBrand: async () => false,
    createScanJob: async (payload) => {
      createdJobs.push(payload);
      return { id: "job-new-1", ...payload };
    },
    upsertScanSchedule: async (key, updates) => {
      scheduleWrites.push({ key, updates });
      return { brand: key, ...updates };
    },
    runScanChunk: async () => ({ ok: true }),
    getScansByDomain: async (domain) => {
      if (domain === "italicatiles.com") {
        return [MANUAL_SCAN_1]; // Previous scan had brand: "Italica"
      }
      return [];
    },
  };

  await runSchedulerTick("2026-08-01T00:00:00.000Z", fakeDeps);

  // 1. The job must be created with brand: "Italica" (shared identity), NOT domain!
  assert.equal(createdJobs.length, 1);
  assert.equal(
    createdJobs[0].brand,
    "Italica",
    "scheduled scan adopted display name 'Italica' so manual and scheduled scans share one identity"
  );

  // 2. display_name must be written back to scan_schedules!
  const displayNameWrite = scheduleWrites.find((w) => w.updates.display_name === "Italica");
  assert.ok(
    displayNameWrite,
    "display_name is durably written to scan_schedules table on the schedule row"
  );
  assert.equal(displayNameWrite.key, "italicatiles.com");
});

// ---------------------------------------------------------------------------
// 5. Verification Teeth / Sabotage Proof (Rule 11)
// ---------------------------------------------------------------------------

test("R3.4.3 — SABOTAGE TEETH: dropping the domain join leaves the brand history split in two", () => {
  const brandScans = [MANUAL_SCAN_2, MANUAL_SCAN_1];
  const domainScans = [SCHEDULED_SCAN_1];

  // Sabotage implementation: fails to join domainScans
  const sabotagedJoin = (bScans, _dScans) => [...(bScans || [])];

  const sabotaged = sabotagedJoin(brandScans, domainScans);
  assert.notEqual(
    sabotaged.length,
    3,
    "sabotaged join cannot produce the continuous 3-scan history"
  );
  assert.ok(
    !sabotaged.some((s) => s.id === "scan-s-1"),
    "scheduled scan is lost without the join — proving teeth of R3.4.3"
  );

  // Correct implementation:
  const proper = joinScanIdentities(brandScans, domainScans);
  assert.equal(proper.length, 3);
  assert.ok(proper.some((s) => s.id === "scan-s-1"));
});
