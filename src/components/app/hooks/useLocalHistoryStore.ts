"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/hooks/useLocalHistoryStore.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HISTORY_LIMIT,
  loadHistory,
  addHistoryItem,
  removeHistoryItem,
  saveHistory,
} from "@/shared/query/localHistory";

export type UseLocalHistoryStoreOptions<TItem, TAddInput> = {
  storageKey: string;
  maxItems?: number;
  parse: (raw: string) => TItem[] | null;
  isSameItem: (existing: TItem, next: TAddInput) => boolean;
  createItem: (input: TAddInput) => TItem;
  getItemKey: (item: TItem) => number;
};

export function useLocalHistoryStore<TItem, TAddInput>({
  storageKey,
  maxItems = HISTORY_LIMIT,
  parse,
  isSameItem,
  createItem,
  getItemKey,
}: UseLocalHistoryStoreOptions<TItem, TAddInput>) {
  const parseRef = useRef(parse);
  const [history, setHistory] = useState<TItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    parseRef.current = parse;
  }, [parse]);

  useEffect(() => {
    const storage = typeof window !== "undefined" ? window.localStorage : null;
    setHistory(loadHistory(storage, storageKey, parseRef.current, maxItems));
    setIsLoaded(true);
  }, [maxItems, storageKey]);

  const addItem = useCallback(
    (input: TAddInput) => {
      setHistory((prev) => {
        const next = addHistoryItem(prev, input, {
          isSame: isSameItem,
          create: createItem,
          max: maxItems,
        });
        const storage = typeof window !== "undefined" ? window.localStorage : null;
        saveHistory(storage, storageKey, next);
        return next;
      });
    },
    [createItem, isSameItem, maxItems, storageKey]
  );

  const removeItem = useCallback(
    (itemKey: number) => {
      setHistory((prev) => {
        const next = removeHistoryItem(prev, itemKey, getItemKey);
        const storage = typeof window !== "undefined" ? window.localStorage : null;
        saveHistory(storage, storageKey, next);
        return next;
      });
    },
    [getItemKey, storageKey]
  );

  const clearItems = useCallback(() => {
    setHistory([]);
    const storage = typeof window !== "undefined" ? window.localStorage : null;
    saveHistory(storage, storageKey, []);
  }, [storageKey]);

  return { history, isLoaded, addItem, removeItem, clearItems };
}
