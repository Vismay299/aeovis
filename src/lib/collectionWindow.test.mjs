import test from "node:test";
import assert from "node:assert/strict";
import { collectionWindow } from "./workers/scanWorker.js";
import { formatCollectionWindow } from "../utils/format.js";

/**
 * R2.7.4 — persist and render the window the answers were collected in.
 *
 * `scanned_at` is stamped when finalize runs. On a chunked scan that can be
 * long after the first probe, and on a crash-resumed one it can be the next
 * day. Reporting it as "when this was measured" compresses a real span to a
 * point, and picks the end furthest from most of the evidence.
 */

const T = (iso) => ({ created_at: iso });

test("collectionWindow — first and last probe write, not the finalize instant", () => {
  const rows = [
    T("2026-08-30T10:05:00.000Z"),
    T("2026-08-30T10:00:00.000Z"), // earliest, deliberately out of order
    T("2026-08-30T10:42:00.000Z"), // latest
  ];

  assert.deepEqual(collectionWindow(rows), {
    collected_from: "2026-08-30T10:00:00.000Z",
    collected_to: "2026-08-30T10:42:00.000Z",
  });
});

test("collectionWindow — an unknown window reads as unknown, never as now", () => {
  // The failure this replaces: a missing collection time silently becoming the
  // moment the code happened to run. Nulls, so the UI can omit the chip.
  assert.deepEqual(collectionWindow([]), { collected_from: null, collected_to: null });
  assert.deepEqual(collectionWindow(null), { collected_from: null, collected_to: null });
  assert.deepEqual(collectionWindow([{}, {}]), { collected_from: null, collected_to: null });
  assert.deepEqual(collectionWindow([T("not-a-date")]), {
    collected_from: null,
    collected_to: null,
  });
});

test("collectionWindow — partial timestamps still yield a real window", () => {
  const w = collectionWindow([T("2026-08-30T10:00:00.000Z"), {}, T("bad"), T("2026-08-30T11:00:00.000Z")]);
  assert.equal(w.collected_from, "2026-08-30T10:00:00.000Z");
  assert.equal(w.collected_to, "2026-08-30T11:00:00.000Z");
});

test("collectionWindow — a single row is a zero-length window, not a null one", () => {
  const w = collectionWindow([T("2026-08-30T10:00:00.000Z")]);
  assert.equal(w.collected_from, "2026-08-30T10:00:00.000Z");
  assert.equal(w.collected_to, "2026-08-30T10:00:00.000Z");
});

test("formatCollectionWindow — reads as a span at every scale", () => {
  const base = Date.parse("2026-08-30T10:00:00.000Z");
  const at = (ms) => new Date(base + ms).toISOString();

  // Tested on the raw span, not rounded minutes: Math.round(30s) is 1 minute,
  // which reported a half-minute window as "over 1 min".
  assert.equal(formatCollectionWindow(at(0), at(30_000)), "in under a minute");
  assert.equal(formatCollectionWindow(at(0), at(0)), "in under a minute");
  assert.equal(formatCollectionWindow(at(0), at(42 * 60_000)), "over 42 min");
  assert.equal(formatCollectionWindow(at(0), at(60 * 60_000)), "over 1 hour");
  assert.equal(formatCollectionWindow(at(0), at(5 * 3_600_000)), "over 5 hours");
  assert.equal(formatCollectionWindow(at(0), at(48 * 3_600_000)), "over 2 days");
});

test("formatCollectionWindow — a half-known window renders nothing", () => {
  assert.equal(formatCollectionWindow(null, "2026-08-30T10:00:00.000Z"), null);
  assert.equal(formatCollectionWindow("2026-08-30T10:00:00.000Z", null), null);
  assert.equal(formatCollectionWindow("nonsense", "also nonsense"), null);
});
