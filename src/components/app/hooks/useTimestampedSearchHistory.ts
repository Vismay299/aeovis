"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/hooks/useTimestampedSearchHistory.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { useLocalHistoryStore } from "./useLocalHistoryStore";
import { jsonCodec } from "@/shared/json";

const timestampFieldSchema = z.object({ timestamp: z.number() });

export function useTimestampedSearchHistory<TBody extends object>(args: {
  storageKey: string;
  bodySchema: z.ZodType<TBody>;
  isSame: (existing: TBody, next: TBody) => boolean;
  maxItems?: number;
}) {
  type StoredItem = TBody & { timestamp: number };
  const codec = jsonCodec(
    z.array(z.intersection(args.bodySchema, timestampFieldSchema))
  );

  const { history, isLoaded, addItem, removeItem, clearItems } = useLocalHistoryStore<
    StoredItem,
    TBody
  >({
    storageKey: args.storageKey,
    maxItems: args.maxItems ?? 20,
    parse: (raw) => {
      const parsed = codec.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    isSameItem: (existing, next) => args.isSame(existing, next),
    createItem: (input) => ({ ...input, timestamp: Date.now() }),
    getItemKey: (item) => item.timestamp,
  });

  return {
    history,
    isLoaded,
    addSearch: addItem,
    removeHistoryItem: removeItem,
    clearHistory: clearItems,
  };
}
