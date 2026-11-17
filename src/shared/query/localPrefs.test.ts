// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/keywords/hooks/usePreferredKeywordLocation.ts
//   src/client/features/keywords/page/KeywordResearchPagination.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { prefStorageKey, readPref, writePref } from "./localPrefs.ts";

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

test("prefStorageKey: format with and without brandKey", () => {
  assert.equal(prefStorageKey("pageSize"), "perceev:pref:pageSize");
  assert.equal(prefStorageKey("pageSize", "acme"), "perceev:pref:pageSize:acme");
});

test("readPref: valid JSON passes schema; invalid JSON or schema failure returns fallback", () => {
  const storage = createFakeStorage();
  const schema = z.object({ limit: z.number().min(10) });
  const fallback = { limit: 20 };
  const key = prefStorageKey("pageLimit");

  // Missing key -> fallback
  assert.deepEqual(readPref(storage, key, schema, fallback), { limit: 20 });

  // Valid JSON and matches schema
  storage.setItem(key, JSON.stringify({ limit: 50 }));
  assert.deepEqual(readPref(storage, key, schema, fallback), { limit: 50 });

  // Schema failure (limit < 10) -> fallback
  storage.setItem(key, JSON.stringify({ limit: 5 }));
  assert.deepEqual(readPref(storage, key, schema, fallback), { limit: 20 });

  // Invalid JSON -> fallback
  storage.setItem(key, "not valid json {");
  assert.deepEqual(readPref(storage, key, schema, fallback), { limit: 20 });
});

test("writePref & readPref: storage null or throwing handled gracefully", () => {
  const schema = z.string();
  assert.equal(readPref(null, "key", schema, "fallback"), "fallback");
  assert.equal(writePref(null, "key", "val"), false);

  const throwingStorage = createThrowingStorage();
  assert.equal(readPref(throwingStorage, "key", schema, "fallback"), "fallback");
  assert.equal(writePref(throwingStorage, "key", "val"), false);
});
