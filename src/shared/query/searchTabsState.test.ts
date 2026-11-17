// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/search-tabs/useSearchTabs.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  appendTabWithEviction,
  parseStoredState,
  openTabState,
  setActiveState,
  closeTabState,
  markViewedState,
  searchTabsStorageKey,
  type SearchTab,
  type TabsState,
} from "./searchTabsState.ts";

const inputSchema = z.object({
  type: z.literal("q"),
  text: z.string().min(1),
});

type TestInput = z.infer<typeof inputSchema>;

function parseInput(raw: unknown): TestInput | null {
  const result = inputSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function makeTab(index: number): SearchTab<TestInput> {
  return {
    id: `tab-${index}`,
    label: `query-${index}`,
    createdAt: index,
    viewedAt: null,
    input: { type: "q", text: `query-${index}` },
  };
}

test("searchTabsStorageKey: formats key", () => {
  assert.equal(
    searchTabsStorageKey("keywords", "acme"),
    "perceev:search-tabs:keywords:acme"
  );
});

test("appendTabWithEviction: evicts oldest tab at capacity (20)", () => {
  const tabs = Array.from({ length: 20 }, (_, i) => makeTab(i));
  const next = appendTabWithEviction(tabs, makeTab(20));

  assert.equal(next.length, 20);
  assert.equal(next[0].id, "tab-1");
  assert.equal(next[19].id, "tab-20");
});

test("parseStoredState: stored 25 keep newest tab-5...tab-24", () => {
  const stored = {
    activeTabId: "tab-10",
    tabs: Array.from({ length: 25 }, (_, i) => ({
      id: `tab-${i}`,
      label: `query-${i}`,
      createdAt: i,
      viewedAt: null,
      input: { type: "q", text: `query-${i}` },
    })),
  };

  const parsed = parseStoredState(stored, parseInput);
  assert.equal(parsed.tabs.length, 20);
  assert.equal(parsed.tabs[0].id, "tab-5");
  assert.equal(parsed.tabs[19].id, "tab-24");
  assert.equal(parsed.activeTabId, "tab-10");
});

test("parseStoredState: malformed tabs dropped, activeTabId kept only when present", () => {
  const stored = {
    activeTabId: "tab-missing",
    tabs: [
      { id: "tab-1", label: "valid", createdAt: 1, viewedAt: null, input: { type: "q", text: "good" } },
      { id: "tab-2", label: "bad input", createdAt: 2, viewedAt: null, input: { type: "other" } },
      { id: "", label: "no id", createdAt: 3, viewedAt: null, input: { type: "q", text: "x" } },
      { id: "tab-4", label: "no timestamp", viewedAt: null, input: { type: "q", text: "x" } },
    ],
  };

  const parsed = parseStoredState(stored, parseInput);
  assert.equal(parsed.tabs.length, 1);
  assert.equal(parsed.tabs[0].id, "tab-1");
  assert.equal(parsed.activeTabId, null); // "tab-missing" not among kept tabs
});

test("openTabState: re-opening an identical input re-activates without adding a new tab", () => {
  const initial: TabsState<TestInput> = {
    tabs: [makeTab(1), makeTab(2)],
    activeTabId: "tab-1",
  };

  // Re-open tab 2's input
  const updated = openTabState(initial, {
    id: "tab-new",
    label: "query-2",
    input: { type: "q", text: "query-2" },
    now: 100,
  });

  assert.equal(updated.tabs.length, 2);
  assert.equal(updated.activeTabId, "tab-2");

  // Open brand new input
  const added = openTabState(updated, {
    id: "tab-3",
    label: "query-3",
    input: { type: "q", text: "query-3" },
    now: 101,
  });

  assert.equal(added.tabs.length, 3);
  assert.equal(added.activeTabId, "tab-3");
});

test("setActiveState: selects valid tab, ignores invalid, returns same state if unchanged", () => {
  const s: TabsState<TestInput> = {
    tabs: [makeTab(1), makeTab(2)],
    activeTabId: "tab-1",
  };

  assert.equal(setActiveState(s, "tab-1"), s); // identity preserved
  assert.equal(setActiveState(s, "non-existent"), s);

  const switched = setActiveState(s, "tab-2");
  assert.equal(switched.activeTabId, "tab-2");

  const cleared = setActiveState(switched, null);
  assert.equal(cleared.activeTabId, null);
});

test("closeTabState: closing active tab selects right neighbour, else left neighbour", () => {
  // Tabs: [tab-0, tab-1, tab-2]
  const s: TabsState<TestInput> = {
    tabs: [makeTab(0), makeTab(1), makeTab(2)],
    activeTabId: "tab-1",
  };

  // Close middle active tab-1 -> selects right neighbour tab-2
  const res1 = closeTabState(s, "tab-1");
  assert.equal(res1.closedActive, true);
  assert.equal(res1.state.tabs.length, 2);
  assert.equal(res1.state.activeTabId, "tab-2");
  assert.equal(res1.nextActiveTab?.id, "tab-2");

  // Close last active tab-2 -> selects left neighbour tab-0
  const res2 = closeTabState(res1.state, "tab-2");
  assert.equal(res2.closedActive, true);
  assert.equal(res2.state.tabs.length, 1);
  assert.equal(res2.state.activeTabId, "tab-0");
  assert.equal(res2.nextActiveTab?.id, "tab-0");

  // Close sole tab-0 -> empty, null active
  const res3 = closeTabState(res2.state, "tab-0");
  assert.equal(res3.closedActive, true);
  assert.equal(res3.state.tabs.length, 0);
  assert.equal(res3.state.activeTabId, null);
  assert.equal(res3.nextActiveTab, null);

  // Close non-active tab
  const s4: TabsState<TestInput> = {
    tabs: [makeTab(0), makeTab(1)],
    activeTabId: "tab-0",
  };
  const res4 = closeTabState(s4, "tab-1");
  assert.equal(res4.closedActive, false);
  assert.equal(res4.state.activeTabId, "tab-0");
});

test("markViewedState: updates viewedAt when timestamp is newer, preserves identity otherwise", () => {
  const tab = makeTab(1);
  const s: TabsState<TestInput> = {
    tabs: [tab],
    activeTabId: "tab-1",
  };

  const viewed = markViewedState(s, "tab-1", 500);
  assert.equal(viewed.tabs[0].viewedAt, 500);

  // Stale or equal timestamp does not alter state
  const same = markViewedState(viewed, "tab-1", 400);
  assert.equal(same, viewed);
});
