"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/hooks/useCopy.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Copies text to the clipboard with a toast. `copied` stays true for two
 * seconds after a copy, for a check mark on the button.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Do not reset state on a component that has gone away.
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error("Could not copy to clipboard");
      return false;
    }
    toast.success(successMessage);
    setCopied(true);
    // A second copy restarts the two seconds.
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
    return true;
  };

  return { copied, copy };
}
