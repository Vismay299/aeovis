import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSampleManifest,
  isSampleRecord,
  assertSampleNotMutated,
  SAMPLE_FIXED_TIMESTAMP,
  SAMPLE_SURFACES,
  SAMPLE_PROMPT_SET,
} from "../../shared/sampleIsolation.js";
import { normalizeResult, addContentEvent, saveScan, loadScan, clearSampleHandoff, REAL_STORAGE_KEY, SAMPLE_STORAGE_KEY } from "../../shared/api.js";
import { SAMPLE_RESULT } from "../../shared/mockData.js";

test("R07-01 — sample manifest builds 30 unique prompts across 4 surfaces = 120 unique observations", () => {
  const manifest = buildSampleManifest("Brightwave", "brightwave.io");

  assert.equal(manifest.prompts_count, 30);
  assert.equal(manifest.surfaces.length, 4);
  assert.equal(manifest.total_observations, 120);
  assert.equal(manifest.rows.length, 120);

  const uniqueObsIds = new Set(manifest.rows.map((r) => r.observation_id));
  assert.equal(uniqueObsIds.size, 120, "each observation row must have a unique observation_id");
});

test("R07-02 — each surface contains the exact same 30 prompt IDs, not an 8/8/7/7 partition", () => {
  const manifest = buildSampleManifest();

  for (const surface of SAMPLE_SURFACES) {
    const surfaceRows = manifest.rows.filter((r) => r.engine === surface);
    assert.equal(surfaceRows.length, 30, `surface ${surface} must contain 30 rows`);

    const surfacePromptIds = surfaceRows.map((r) => r.prompt_id);
    assert.equal(new Set(surfacePromptIds).size, 30, `surface ${surface} must have 30 unique prompt IDs`);

    // Verify all prompt IDs match SAMPLE_PROMPT_SET
    for (const prompt of SAMPLE_PROMPT_SET) {
      assert.ok(
        surfacePromptIds.includes(prompt.id),
        `surface ${surface} must include prompt ${prompt.id}`
      );
    }
  }
});

test("R07-03 — raw sample with isSample: marker and fixed illustrative timestamp survive normalization (A06 corrected)", () => {
  const rawSample = {
    brand: "Brightwave",
    website: "brightwave.io",
    isSample: true,
    scanned_at: SAMPLE_FIXED_TIMESTAMP,
    results: [
      {
        prompt: "best EHR platform",
        engine: "aio",
        is_branded_query: false,
        answer_present: true,
        visible: true,
        brand_mentioned_in_text: true,
        brand_cited: false,
      },
    ],
  };

  const normalized = normalizeResult(rawSample, "Brightwave", "brightwave.io");

  assert.equal(normalized.isSample, true, "sample marker must survive normalization");
  assert.equal(normalized.sample, true);
  assert.equal(normalized.scanTimestamp, SAMPLE_FIXED_TIMESTAMP, "fixed illustrative timestamp survives");
  assert.ok(normalized.enginesCounted >= 1, "counted engines must not default to zero");
});

test("R07-04 — already-normalized sample normalizes again with idempotent fields, flags, and counts", () => {
  const firstPass = normalizeResult(
    { ...SAMPLE_RESULT, isSample: true },
    "Brightwave",
    "brightwave.io"
  );
  const secondPass = normalizeResult(firstPass, "Brightwave", "brightwave.io");

  assert.equal(firstPass.isSample, secondPass.isSample);
  assert.equal(firstPass.scanTimestamp, secondPass.scanTimestamp);
  assert.equal(firstPass.visibilityScore, secondPass.visibilityScore);
  assert.equal(firstPass.enginesCounted, secondPass.enginesCounted);
  assert.equal(firstPass.queriesTracked, secondPass.queriesTracked);
});

test("R07-05 — sample metric fixture satisfies R05 headline qualification with counted engines", () => {
  const sampleData = {
    ...SAMPLE_RESULT,
    isSample: true,
    engines_counted: 4,
  };

  const normalized = normalizeResult(sampleData, "Brightwave", "brightwave.io");
  assert.equal(normalized.enginesCounted, 4);
  assert.notEqual(normalized.enginesCounted, 0, "no contradictory zero-engine score");
  assert.ok(normalized.isSample);
});

test("R07-06 — fake clock advanced by one day preserves fixed illustrative timestamp", () => {
  const origNow = Date.now;
  try {
    // Fast-forward clock by 24 hours
    Date.now = () => new Date("2026-10-17T12:00:00.000Z").getTime();

    const manifest = buildSampleManifest();
    assert.equal(
      manifest.scanTimestamp,
      SAMPLE_FIXED_TIMESTAMP,
      "illustrative timestamp stays fixed regardless of current time"
    );

    const normalized = normalizeResult(manifest, "Brightwave", "brightwave.io");
    assert.equal(normalized.scanTimestamp, SAMPLE_FIXED_TIMESTAMP);
  } finally {
    Date.now = origNow;
  }
});

test("R07-07 — sample route / storage isolation prevents sample data from overwriting real history", () => {
  // Mock sessionStorage in node
  const storage = new Map();
  global.sessionStorage = {
    setItem: (k, v) => storage.set(k, String(v)),
    getItem: (k) => storage.get(k) ?? null,
    removeItem: (k) => storage.delete(k),
  };

  // 1. Store a real scan
  const realScan = { brand: "Acme", website: "acme.com", isSample: false, visibilityScore: 85 };
  saveScan(realScan);
  assert.ok(storage.has(REAL_STORAGE_KEY));

  // 2. Open sample report
  const sampleScan = { ...SAMPLE_RESULT, isSample: true };
  saveScan(sampleScan);
  assert.ok(storage.has(SAMPLE_STORAGE_KEY));

  // 3. Verify real scan in real storage was not overwritten
  const loadedReal = JSON.parse(storage.get(REAL_STORAGE_KEY));
  assert.equal(loadedReal.brand, "Acme");
  assert.equal(loadedReal.isSample, false);

  // 4. Clearing sample handoff removes only sample key
  clearSampleHandoff();
  assert.equal(storage.has(SAMPLE_STORAGE_KEY), false);
  assert.equal(storage.has(REAL_STORAGE_KEY), true);
});

test("R07-08 — forged sample action bypasses disabled UI: service boundary rejects real effects", async () => {
  const forgedSamplePayload = {
    brand: "Brightwave",
    url: "https://brightwave.io/post",
    publishDate: "2026-10-16",
    isSample: true,
  };

  await assert.rejects(
    async () => {
      await addContentEvent(forgedSamplePayload);
    },
    (err) => {
      assert.match(err.message, /Cannot add content event on sample demonstration data/);
      assert.equal(err.code, "SAMPLE_MUTATION_FORBIDDEN");
      return true;
    }
  );
});
