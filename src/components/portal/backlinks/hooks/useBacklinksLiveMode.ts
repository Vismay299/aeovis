"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useBacklinksLiveMode(target?: string) {
  const [isLive, setIsLive] = useState(false);
  // The ceiling the customer approved for the lookup; sent as maxUsd so the
  // route enforces it (backlinks actions are implicit-approval: a request
  // without maxUsd is approved at whatever the server prices it).
  const [lookupMaxUsd, setLookupMaxUsd] = useState<number | undefined>(undefined);
  const [currentTarget, setCurrentTarget] = useState(target);
  const pendingLiveTarget = useRef<string | undefined>(undefined);

  // When target changes, reset live mode unless explicitly activated
  useEffect(() => {
    if (target !== currentTarget) {
      const preserveLiveMode = target != null && pendingLiveTarget.current === target;
      pendingLiveTarget.current = undefined;
      setCurrentTarget(target);
      if (!preserveLiveMode) {
        setIsLive(false);
        setLookupMaxUsd(undefined);
      }
    }
  }, [target, currentTarget]);

  const enterLiveMode = useCallback((nextTarget?: string, maxUsd?: number) => {
    if (nextTarget !== undefined && nextTarget !== target) {
      pendingLiveTarget.current = nextTarget;
    }
    setLookupMaxUsd(maxUsd);
    setIsLive(true);
  }, [target]);

  const resetLiveMode = useCallback(() => {
    setIsLive(false);
    setLookupMaxUsd(undefined);
  }, []);

  return {
    isLive,
    lookupMaxUsd,
    enterLiveMode,
    resetLiveMode,
  };
}
