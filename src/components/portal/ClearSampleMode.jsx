"use client";

import { useEffect } from "react";
import { SAMPLE_COOKIE } from "@/shared/sample/mode";

/** Reaching any sign-in surface leaves the sample workspace. */
export default function ClearSampleMode() {
  useEffect(() => {
    document.cookie = `${SAMPLE_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`;
  }, []);
  return null;
}
