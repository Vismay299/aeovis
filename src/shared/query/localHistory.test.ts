// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/hooks/useLocalHistoryStore.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_LIMIT,
  historyStorageKey,
  loadHistory,
  addHistoryItem,
  removeHistoryItem,
  saveHistory,
} from "./localHistory.ts";

function createFakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

function createThrowingStorage(): Storage {
  return {
    getItem() {
      throw new Error("QuotaExceededError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("QuotaExceededError");
    },
    clear() {
      throw new Error("QuotaExceededError");
    },
    key() {
      throw new Error("QuotaExceededError");
    },
    get length(): number {
      throw new Error("QuotaExceededError");
    },
  };
}

test("historyStorageKey: formats key", () => {
  assert.equal(historyStorageKey("prompt", "acme"), "perceev:recent:prompt:acme");
});

test("addHistoryItem: puts newest first and removes the duplicate", () => {
  type Item = { id: string; query: string; timestamp: number };
  const items: Item[] = [
    { id: "1", query: "apple", timestamp: 1 },
    { id: "2", query: "banana", timestamp: 2 },
  ];

  // Re-add "apple" with new timestamp 3
  const next = addHistoryItem(items, "apple", {
    isSame: (existing, input) => existing.query === input,
    create: (input) => ({ id: "3", query: input, timestamp: 3 }),
  });

  assert.equal(next.length, 2);
  assert.equal(next[0].query, "apple");
  assert.equal(next[0].id, "3");
  assert.equal(next[1].query, "banana");
});

test("addHistoryItem: 21st item drops the oldest", () => {
  type Item = { query: string; timestamp: number };
  const items: Item[] = Array.from({ length: 20 }, (_, i) => ({
    query: `q-${i}`,
    timestamp: i,
  }));

  const next = addHistoryItem(items, "q-21", {
    isSame: (existing, input) => existing.query === input,
    create: (input) => ({ query: input, timestamp: 100 }),
  });

  assert.equal(next.length, 20);
  assert.equal(next[0].query, "q-21");
  assert.equal(next[19].query, "q-18"); // q-19 dropped
});

test("removeHistoryItem: removes item by key", () => {
  type Item = { id: string; timestamp: number };
  const items: Item[] = [
    { id: "1", timestamp: 10 },
    { id: "2", timestamp: 20 },
    { id: "3", timestamp: 30 },
  ];

  const filtered = removeHistoryItem(items, 20, (item) => item.timestamp);
  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered.map((i) => i.id),
    ["1", "3"]
  );
});

test("loadHistory: invalid stored JSON -> []", () => {
  const storage = createFakeStorage();
  storage.setItem("key", "{ not valid json");
  const parse = (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const loaded = loadHistory(storage, "key", parse);
  assert.deepEqual(loaded, []);
});

test("saveHistory: throwing storage does not throw", () => {
  const throwingStorage = createThrowingStorage();
  assert.doesNotThrow(() => {
    saveHistory(throwingStorage, "key", [{ a: 1 }]);
  });
});
