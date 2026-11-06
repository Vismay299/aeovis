"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/keywords/hooks/usePreferredKeywordLocation.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useSyncExternalStore } from "react";
import { prefStorageKey, readPref, writePref } from "@/lib/query/localPrefs";

const PREF_CHANGE_EVENT = "perceev:pref-change";
const memoryPrefs = new Map<string, unknown>();
const prefCache = new Map<string, { raw: string | null; parsed: unknown }>();

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PREF_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREF_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useLocalPref<T>(
  key: string,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  fallback: T,
  options?: { brandKey?: string }
): readonly [T, (value: T) => void] {
  const fullKey = prefStorageKey(key, options?.brandKey);

  const getSnapshot = useCallback((): T => {
    if (typeof window === "undefined") return fallback;
    if (memoryPrefs.has(fullKey)) {
      return memoryPrefs.get(fullKey) as T;
    }

    try {
      const raw = window.localStorage.getItem(fullKey);
      const cached = prefCache.get(fullKey);
      if (cached && cached.raw === raw) {
        return cached.parsed as T;
      }
      const parsed = readPref(window.localStorage, fullKey, schema, fallback);
      prefCache.set(fullKey, { raw, parsed });
      return parsed;
    } catch {
      return fallback;
    }
  }, [fallback, fullKey, schema]);

  const getServerSnapshot = useCallback((): T => fallback, [fallback]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T) => {
      const storage = typeof window !== "undefined" ? window.localStorage : null;
      const ok = writePref(storage, fullKey, next);
      if (!ok) {
        memoryPrefs.set(fullKey, next);
      } else {
        memoryPrefs.delete(fullKey);
        prefCache.set(fullKey, { raw: JSON.stringify(next), parsed: next });
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(PREF_CHANGE_EVENT, { detail: { key: fullKey } })
        );
      }
    },
    [fullKey]
  );

  return [value, setValue] as const;
}
