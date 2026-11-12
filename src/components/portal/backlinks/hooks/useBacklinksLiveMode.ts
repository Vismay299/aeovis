"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useBacklinksLiveMode(target?: string) {
  const [isLive, setIsLive] = useState(false);
  const [currentTarget, setCurrentTarget] = useState(target);
  const pendingLiveTarget = useRef<string | undefined>(undefined);

  // When target changes, reset live mode unless explicitly activated
  useEffect(() => {
    if (target !== currentTarget) {
      const preserveLiveMode = target != null && pendingLiveTarget.current === target;
      pendingLiveTarget.current = undefined;
      setCurrentTarget(target);
      if (!preserveLiveMode) setIsLive(false);
    }
  }, [target, currentTarget]);

  const enterLiveMode = useCallback((nextTarget?: string) => {
    if (nextTarget !== undefined && nextTarget !== target) {
      pendingLiveTarget.current = nextTarget;
    }
    setIsLive(true);
  }, [target]);

  const resetLiveMode = useCallback(() => {
    setIsLive(false);
  }, []);

  return {
    isLive,
    enterLiveMode,
    resetLiveMode,
  };
}
