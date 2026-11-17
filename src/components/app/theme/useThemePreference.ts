"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/theme.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import * as React from "react";
import {
  type ThemePreference,
  type ResolvedTheme,
  THEME_STORAGE_KEY,
  THEME_CHANGE_EVENT,
  surfaceForPath,
  parsePreference,
  resolveTheme,
} from "@/shared/theme/theme";

// Set when localStorage cannot store a pick (private browsing, strict modes,
// a full quota): the pick then holds for this page session and wins over
// whatever localStorage still returns.
let unsavedThemePreference: ThemePreference | null = null;

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  if (unsavedThemePreference) {
    return unsavedThemePreference;
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return parsePreference(stored);
  } catch {
    return "system";
  }
}

function writeThemePreference(themePreference: ThemePreference) {
  try {
    if (themePreference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }
    unsavedThemePreference = null;
  } catch {
    unsavedThemePreference = themePreference;
  }
}

function applyThemePreference(themePreference: ThemePreference) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const surface = surfaceForPath(window.location.pathname);
  if (surface.themeMode === "user") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = resolveTheme(themePreference, prefersDark, "user");
    document.documentElement.setAttribute("data-theme", resolved);
  }
}

function subscribeToThemePreference(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleThemeChange = () => {
    onStoreChange();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== THEME_STORAGE_KEY) {
      return;
    }
    onStoreChange();
  };

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    // Re-apply when OS preference changes so "system" mode stays in sync
    applyThemePreference(readThemePreference());
    onStoreChange();
  };

  window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  window.addEventListener("storage", handleStorage);
  mediaQuery.addEventListener("change", handleMediaChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    window.removeEventListener("storage", handleStorage);
    mediaQuery.removeEventListener("change", handleMediaChange);
  };
}

export function useThemePreference() {
  const themePreference = React.useSyncExternalStore<ThemePreference>(
    subscribeToThemePreference,
    readThemePreference,
    () => "system",
  );

  React.useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  const setThemePreference = React.useCallback(
    (nextThemePreference: ThemePreference) => {
      writeThemePreference(nextThemePreference);
      applyThemePreference(nextThemePreference);
      window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    },
    [],
  );

  const resolvedTheme: ResolvedTheme = React.useMemo(() => {
    if (typeof window === "undefined") return "light";
    const surface = surfaceForPath(window.location.pathname);
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return resolveTheme(themePreference, prefersDark, surface.themeMode);
  }, [themePreference]);

  return { themePreference, resolvedTheme, setThemePreference };
}
