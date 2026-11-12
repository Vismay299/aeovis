"use client";

import { useEffect, useState } from "react";

export function useDomainLiveMode(brandKey: string) {
  const [liveMode, setLiveMode] = useState(false);

  useEffect(() => {
    setLiveMode(false);
  }, [brandKey]);

  return {
    liveMode,
    enableLiveMode: () => setLiveMode(true),
  };
}
