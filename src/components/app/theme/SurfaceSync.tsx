"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  surfaceForPath,
  resolveTheme,
  parsePreference,
  THEME_STORAGE_KEY,
} from "@/shared/theme/theme";

export function SurfaceSync() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const currentPath = pathname || "/";
    const { surface, themeMode } = surfaceForPath(currentPath);
    const root = document.documentElement;

    if (surface === "app") {
      root.setAttribute("data-surface", "app");
    } else {
      root.removeAttribute("data-surface");
    }

    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // localStorage unavailable (e.g. strict privacy mode)
    }

    const pref = parsePreference(raw);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = resolveTheme(pref, prefersDark, themeMode);

    root.setAttribute("data-theme", resolved);
  }, [pathname]);

  return null;
}

export default SurfaceSync;
