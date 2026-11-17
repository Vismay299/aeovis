// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/server/workflows/rankCheckPaths.test.ts:113-199.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRetryPairs, needsRetry, selectRetryResults, unconfirmedMisses } from "./retries.ts";

test("errored pairs retry while an unranked miss is not treated as a confirmed loss", () => {
  const pairs = buildRetryPairs({
    keywords: [{ trackingKeywordId: "new", keyword: "new keyword" }], devices: "desktop",
    current: [], previous: [],
  });
  assert.equal(needsRetry(pairs[0]), true);
  assert.deepEqual(unconfirmedMisses(pairs), []);
});

test("a ten-position drop retries and selection keeps the best position", () => {
  const pairs = buildRetryPairs({
    keywords: [{ trackingKeywordId: "kw", keyword: "keyword" }], devices: "desktop",
    current: [{ trackingKeywordId: "kw", device: "desktop", position: 11 }],
    previous: [{ trackingKeywordId: "kw", position: 1 }],
  });
  assert.equal(needsRetry(pairs[0]), true);
  const result = selectRetryResults(pairs, [{ trackingKeywordId: "kw", device: "desktop", position: 4 }]);
  assert.equal(result.pairs[0].position, 4);
  assert.equal(result.snapshotsToSave[0].position, 4);
});

test("a rank found on the other device makes the miss suspect", () => {
  const pairs = buildRetryPairs({
    keywords: [{ trackingKeywordId: "kw", keyword: "keyword" }], devices: "both",
    current: [{ trackingKeywordId: "kw", device: "mobile", position: 3 }], previous: [],
  });
  assert.equal(pairs.find((pair) => pair.device === "desktop")?.knownPosition, 3);
  assert.deepEqual(unconfirmedMisses(pairs), [{ trackingKeywordId: "kw", device: "desktop" }]);
});

test("a new keyword can be found on the second recheck after a first miss", () => {
  const initial = buildRetryPairs({ keywords: [{ trackingKeywordId: "kw", keyword: "keyword" }], devices: "desktop", current: [], previous: [] });
  const first = selectRetryResults(initial, [{ trackingKeywordId: "kw", device: "desktop", position: null }]);
  assert.equal(first.pairs[0].position, null);
  assert.equal(needsRetry(first.pairs[0]), true);
  const second = selectRetryResults(first.pairs, [{ trackingKeywordId: "kw", device: "desktop", position: 3 }]);
  assert.equal(second.pairs[0].position, 3);
});

test("a previously ranked keyword's unconfirmed miss is removed", () => {
  const pairs = buildRetryPairs({
    keywords: [{ trackingKeywordId: "kw", keyword: "keyword" }], devices: "desktop",
    current: [{ trackingKeywordId: "kw", device: "desktop", position: null }],
    previous: [{ trackingKeywordId: "kw", position: 2 }],
  });
  assert.deepEqual(unconfirmedMisses(pairs), [{ trackingKeywordId: "kw", device: "desktop" }]);
});
