"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The lookup an approval belongs to: workspace, target and resolved scope.
 * Live mode (and its approved ceiling) applies to exactly one lookup; any
 * change - a new target, a scope change from a history or tab click, a
 * workspace switch - drops back to cache-only until the customer approves
 * the new lookup.
 */
export function backlinksLookupKey(brandKey: string, target: string | undefined, scope: string): string {
  return JSON.stringify([brandKey, (target ?? "").trim(), scope]);
}

export function useBacklinksLiveMode(lookupKey: string) {
  const [isLive, setIsLive] = useState(false);
  // The ceiling the customer approved for the lookup; sent as maxUsd so the
  // route enforces it (backlinks actions are implicit-approval: a request
  // without maxUsd is approved at whatever the server prices it).
  const [lookupMaxUsd, setLookupMaxUsd] = useState<number | undefined>(undefined);
  const [currentKey, setCurrentKey] = useState(lookupKey);
  const pendingLiveKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (lookupKey !== currentKey) {
      const preserveLiveMode = pendingLiveKey.current === lookupKey;
      pendingLiveKey.current = undefined;
      setCurrentKey(lookupKey);
      if (!preserveLiveMode) {
        setIsLive(false);
        setLookupMaxUsd(undefined);
      }
    }
  }, [lookupKey, currentKey]);

  /** Approve `nextKey` (default: the current lookup) at `maxUsd`. */
  const enterLiveMode = useCallback((maxUsd: number, nextKey?: string) => {
    if (nextKey !== undefined && nextKey !== lookupKey) {
      pendingLiveKey.current = nextKey;
    }
    setLookupMaxUsd(maxUsd);
    setIsLive(true);
  }, [lookupKey]);

  const resetLiveMode = useCallback(() => {
    pendingLiveKey.current = undefined;
    setIsLive(false);
    setLookupMaxUsd(undefined);
  }, []);

  // Live only while the approval belongs to the lookup on screen: guards the
  // render between a key change and the effect above.
  const live = isLive && currentKey === lookupKey;
  return {
    isLive: live,
    lookupMaxUsd: live ? lookupMaxUsd : undefined,
    enterLiveMode,
    resetLiveMode,
  };
}
