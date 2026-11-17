"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/saved.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeFilterValues } from "@/shared/query/filterSearchParams";

export type UseDebouncedFiltersOptions<V extends Record<string, string>> = {
  applied: V;
  empty: V;
  commit: (values: V) => void;
  delayMs?: number; // default 350
  textFields?: readonly string[];
};

export function useDebouncedFilters<V extends Record<string, string>>({
  applied,
  empty,
  commit,
  delayMs = 350,
  textFields,
}: UseDebouncedFiltersOptions<V>) {
  const [draft, setDraft] = useState<V>(applied);
  const awaitingWriteRef = useRef(false);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  const appliedKey = useMemo(() => JSON.stringify(applied), [applied]);

  // When applied changes externally (e.g. back/forward, clear), sync draft
  useEffect(() => {
    if (awaitingWriteRef.current) {
      awaitingWriteRef.current = false;
      return;
    }
    setDraft(applied);
  }, [applied, appliedKey]);

  // Debounced commit of draft to applied
  useEffect(() => {
    const next = normalizeFilterValues(draft, empty, textFields);
    if (JSON.stringify(next) === appliedKey) return;

    const timer = window.setTimeout(() => {
      awaitingWriteRef.current = true;
      commitRef.current(next);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [appliedKey, delayMs, draft, empty, textFields]);

  const setField = useCallback((key: keyof V, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setDraft(empty);
    awaitingWriteRef.current = true;
    commitRef.current(empty);
  }, [empty]);

  const activeCount = useMemo(() => {
    let count = 0;
    for (const val of Object.values(draft)) {
      if (typeof val === "string" && val.trim() !== "") {
        count += 1;
      }
    }
    return count;
  }, [draft]);

  return {
    draft,
    setField,
    reset,
    activeCount,
  };
}
