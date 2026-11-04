import test from "node:test";
import assert from "node:assert/strict";
import { queryStateView } from "./queryStateView.ts";

test("queryStateView - replaces content with error when first load fails", () => {
  const view = queryStateView({
    isPending: false,
    isError: true,
    data: undefined,
  });
  assert.equal(view, "error");
});

test("queryStateView - keeps loaded content on screen when a refetch fails", () => {
  const view = queryStateView({
    isPending: false,
    isError: true,
    data: "rows",
  });
  assert.equal(view, "error+content");
});

test("queryStateView - returns loading when query is pending", () => {
  const viewInitial = queryStateView({
    isPending: true,
    isError: false,
    data: undefined,
  });
  assert.equal(viewInitial, "loading");

  const viewPendingWithData = queryStateView({
    isPending: true,
    isError: false,
    data: "stale",
  });
  assert.equal(viewPendingWithData, "loading");
});

test("queryStateView - returns content on successful resolution", () => {
  const view = queryStateView({
    isPending: false,
    isError: false,
    data: "content:rows",
  });
  assert.equal(view, "content");
});

test("queryStateView - a disabled query is idle, not loading forever", () => {
  const view = queryStateView({
    isPending: true,
    isError: false,
    fetchStatus: "idle",
    data: undefined,
  });
  assert.equal(view, "idle");
});

test("queryStateView - pending while fetching or paused offline is loading", () => {
  for (const fetchStatus of ["fetching", "paused"] as const) {
    const view = queryStateView({
      isPending: true,
      isError: false,
      fetchStatus,
      data: undefined,
    });
    assert.equal(view, "loading");
  }
});
