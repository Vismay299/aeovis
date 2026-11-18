import assert from "node:assert/strict";
import { test } from "node:test";
import { applyShareResult, describeViews } from "./shareState.ts";

const SHARED = {
  shared: true,
  shareToken: "tok-first",
  sharedAt: "2026-11-01T00:00:00.000Z",
  views30d: 5,
};
const PRIVATE = { shared: false, shareToken: null, sharedAt: null, views30d: null };

test("turning sharing off clears the link and its views", () => {
  const next = applyShareResult(SHARED, { shareToken: null, sharedAt: null });
  assert.deepEqual(next, PRIVATE);
});

test("a link minted after a revoke starts at zero views, not the old link's count", () => {
  const revoked = applyShareResult(SHARED, { shareToken: null, sharedAt: null });
  const reshared = applyShareResult(revoked, {
    shareToken: "tok-second",
    sharedAt: "2026-11-02T00:00:00.000Z",
  });
  assert.equal(reshared.shared, true);
  assert.equal(reshared.shareToken, "tok-second");
  assert.equal(reshared.views30d, 0);
});

test("a response naming the link already on the page keeps its views", () => {
  const next = applyShareResult(SHARED, {
    shareToken: "tok-first",
    sharedAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(next.views30d, 5);
});

test("sharing a private report gives a fresh link with zero views", () => {
  const next = applyShareResult(PRIVATE, {
    shareToken: "tok-new",
    sharedAt: "2026-11-03T00:00:00.000Z",
  });
  assert.deepEqual(next, {
    shared: true,
    shareToken: "tok-new",
    sharedAt: "2026-11-03T00:00:00.000Z",
    views30d: 0,
  });
});

test("other report fields pass through untouched", () => {
  const report = { ...SHARED, id: "r1", title: "Audit" };
  const next = applyShareResult(report, { shareToken: null, sharedAt: null });
  assert.equal(next.id, "r1");
  assert.equal(next.title, "Audit");
});

test("the views footnote is singular for one", () => {
  assert.equal(describeViews(1), "Opened 1 time in the last 30 days.");
  assert.equal(describeViews(0), "Opened 0 times in the last 30 days.");
  assert.equal(describeViews(12), "Opened 12 times in the last 30 days.");
});
