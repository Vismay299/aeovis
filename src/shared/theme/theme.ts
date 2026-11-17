// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/theme.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "perceev:theme-preference";
export const THEME_CHANGE_EVENT = "perceev:theme-preference-change";

export const APP_SURFACES = [
  { prefix: "/portal", theme: "user" },
  { prefix: "/onboarding", theme: "user" },
  { prefix: "/login", theme: "user" },
  { prefix: "/signup", theme: "user" },
  { prefix: "/auth", theme: "user" },
  { prefix: "/ops", theme: "light" },
  // Local review page for colour schemes and motion.
  { prefix: "/ui-lab", theme: "user" },
] as const;

export function surfaceForPath(pathname: string): { surface: "app" | "site"; themeMode: "user" | "light" } {
  for (const entry of APP_SURFACES) {
    if (pathname === entry.prefix || pathname.startsWith(entry.prefix + "/")) {
      return { surface: "app", themeMode: entry.theme };
    }
  }
  return { surface: "site", themeMode: "light" };
}

export function parsePreference(raw: string | null): ThemePreference {
  if (raw === "light" || raw === "dark") {
    return raw;
  }
  return "system";
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean, mode: "user" | "light"): ResolvedTheme {
  if (mode === "light") {
    return "light";
  }
  if (pref === "light") {
    return "light";
  }
  if (pref === "dark") {
    return "dark";
  }
  return prefersDark ? "dark" : "light";
}

export function buildThemeInitScript(): string {
  return `(() => {
  try {
    var p = (typeof window !== "undefined" && window.location && window.location.pathname) || (typeof location !== "undefined" && location.pathname) || "/";
    var s = false;
    var m = "light";
    var list = ${JSON.stringify(APP_SURFACES)};
    for (var i = 0; i < list.length; i++) {
      var pfx = list[i].prefix;
      if (p === pfx || p.indexOf(pfx + "/") === 0) {
        s = true;
        m = list[i].theme;
        break;
      }
    }
    var doc = typeof document !== "undefined" ? document : (typeof window !== "undefined" ? window.document : null);
    if (doc && doc.documentElement) {
      if (s) {
        doc.documentElement.setAttribute("data-surface", "app");
      } else {
        doc.documentElement.removeAttribute("data-surface");
      }
      var t = "light";
      if (m === "user") {
        var storage = (typeof window !== "undefined" && window.localStorage) || (typeof localStorage !== "undefined" ? localStorage : null);
        var pref = storage ? storage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) : null;
        if (pref === "dark") {
          t = "dark";
        } else if (pref === "light") {
          t = "light";
        } else {
          var mm = (typeof window !== "undefined" && window.matchMedia) || (typeof matchMedia !== "undefined" ? matchMedia : null);
          t = mm && mm("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
      }
      doc.documentElement.setAttribute("data-theme", t);
    }
  } catch {
    try {
      var d = typeof document !== "undefined" ? document : (typeof window !== "undefined" ? window.document : null);
      if (d && d.documentElement) {
        d.documentElement.removeAttribute("data-surface");
        d.documentElement.setAttribute("data-theme", "light");
      }
    } catch {}
  }
})();`;
}
