/**
 * R1.5.1 — probe-evidence retention: expired objects are removed, fresh and
 * undated ones are kept, folders are walked, and a failure never reads as
 * "nothing expired". No network: Storage is a fake.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { EVIDENCE_RETENTION_DAYS, listEvidenceObjects, pruneProbeEvidence } from "./evidenceRetention.js";

const NOW = new Date("2026-09-15T00:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

/** A fake Storage bucket: `tree` maps a prefix to its entries. */
function fakeStorage(tree, { listError = null, removeError = null } = {}) {
  const removed = [];
  return {
    removed,
    async list(prefix, { limit, offset }) {
      if (listError) return { data: null, error: { message: listError } };
      return { data: (tree[prefix] || []).slice(offset, offset + limit), error: null };
    },
    async remove(paths) {
      if (removeError) return { data: null, error: { message: removeError } };
      removed.push(...paths);
      return { data: paths.map((p) => ({ name: p })), error: null };
    },
  };
}

const file = (name, created_at, size = 100) => ({ id: `id-${name}`, name, created_at, metadata: { size } });
const folder = (name) => ({ id: null, name });

test("the retention window is 90 days", () => {
  assert.equal(EVIDENCE_RETENTION_DAYS, 90);
});

test("walks nested folders and returns full object paths", async () => {
  const storage = fakeStorage({
    "": [folder("job1")],
    job1: [folder("aio")],
    "job1/aio": [file("r1.png", daysAgo(1)), file("r1.html.gz", daysAgo(1))],
  });
  const { files, truncated } = await listEvidenceObjects(storage);
  assert.deepEqual(files.map((f) => f.path).sort(), ["job1/aio/r1.html.gz", "job1/aio/r1.png"]);
  assert.equal(truncated, false);
});

test("removes only objects past the cutoff; fresh and undated objects are kept and counted", async () => {
  const storage = fakeStorage({
    "": [folder("old"), folder("new"), file("mystery.png", "")],
    old: [file("a.png", daysAgo(91), 10), file("b.html.gz", daysAgo(200), 20)],
    new: [file("c.png", daysAgo(89), 30)],
  });
  const report = await pruneProbeEvidence({ storage, now: () => NOW });
  assert.deepEqual(storage.removed.sort(), ["old/a.png", "old/b.html.gz"]);
  assert.equal(report.scanned, 4);
  assert.equal(report.expired, 2);
  assert.equal(report.removed, 2);
  assert.equal(report.undated_kept, 1, "an object with no timestamp is never deleted");
  assert.equal(report.bytes_kept, 30);
});

test("an empty bucket is a measured zero", async () => {
  const report = await pruneProbeEvidence({ storage: fakeStorage({ "": [] }), now: () => NOW });
  assert.equal(report.scanned, 0);
  assert.equal(report.removed, 0);
});

test("QA retention is confined to its exact prefix, including recursive folders", async () => {
  const storage = fakeStorage({
    "": [folder("customer"), folder("qa")], customer: [file("private.json", daysAgo(200))],
    qa: [folder("run")], "qa/run": [file("capture.json", daysAgo(91))],
  });
  const report = await pruneProbeEvidence({ storage, prefix:"qa/run", now:()=>NOW });
  assert.equal(report.scanned,1);
  assert.deepEqual(storage.removed,["qa/run/capture.json"]);
  await assert.rejects(()=>listEvidenceObjects(storage,{prefix:"qa/../customer"}),/Invalid evidence prefix/);
});

test("a list failure throws — it is not '0 expired'", async () => {
  await assert.rejects(
    () => pruneProbeEvidence({ storage: fakeStorage({}, { listError: "bucket not found" }), now: () => NOW }),
    /bucket not found/
  );
});

test("a remove failure throws and says how many were already removed", async () => {
  const storage = fakeStorage({ "": [file("a.png", daysAgo(100))] }, { removeError: "denied" });
  await assert.rejects(() => pruneProbeEvidence({ storage, now: () => NOW }), /Removed 0 of 1 .* denied/);
});

test("the object cap truncates the pass and says so", async () => {
  const storage = fakeStorage({ "": [file("a.png", daysAgo(100)), file("b.png", daysAgo(100)), file("c.png", daysAgo(1))] });
  const report = await pruneProbeEvidence({ storage, now: () => NOW, maxObjects: 2 });
  assert.equal(report.truncated, true);
  assert.equal(report.scanned, 2);
});

test("with no client and no storage the pass refuses to run", async () => {
  await assert.rejects(() => pruneProbeEvidence({ client: null, now: () => NOW }), /did not run/);
});
