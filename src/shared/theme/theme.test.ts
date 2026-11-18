import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  surfaceForPath,
  parsePreference,
  resolveTheme,
  buildThemeInitScript,
  THEME_STORAGE_KEY,
  type ThemePreference,
  type ResolvedTheme,
} from "./theme.ts";

test("surfaceForPath resolves correct surface and theme mode", () => {
  const cases: Array<{ path: string; expected: { surface: "app" | "site"; themeMode: "user" | "light" } }> = [
    { path: "/", expected: { surface: "site", themeMode: "light" } },
    { path: "/methodology", expected: { surface: "site", themeMode: "light" } },
    { path: "/scan", expected: { surface: "site", themeMode: "light" } },
    { path: "/demo", expected: { surface: "site", themeMode: "light" } },
    { path: "/portal", expected: { surface: "app", themeMode: "user" } },
    { path: "/portal/scans/x", expected: { surface: "app", themeMode: "user" } },
    { path: "/portalx", expected: { surface: "site", themeMode: "light" } },
    { path: "/login", expected: { surface: "app", themeMode: "user" } },
    { path: "/auth/reset", expected: { surface: "app", themeMode: "user" } },
    { path: "/ops/measurement", expected: { surface: "app", themeMode: "light" } },
    { path: "/r/11111111-1111-1111-8111-111111111111", expected: { surface: "app", themeMode: "light" } },
  ];

  for (const { path: p, expected } of cases) {
    const actual = surfaceForPath(p);
    assert.deepEqual(actual, expected, `Mismatch for path ${p}`);
  }
});

test("parsePreference parses valid preferences and falls back to system", () => {
  assert.equal(parsePreference("light"), "light");
  assert.equal(parsePreference("dark"), "dark");
  assert.equal(parsePreference("system"), "system");
  assert.equal(parsePreference(null), "system");
  assert.equal(parsePreference("invalid"), "system");
});

test("resolveTheme table evaluates expected resolved theme across all combinations", () => {
  const cases: Array<{
    pref: ThemePreference;
    prefersDark: boolean;
    mode: "user" | "light";
    expected: ResolvedTheme;
  }> = [
    // mode: light always forces light
    { pref: "system", prefersDark: false, mode: "light", expected: "light" },
    { pref: "system", prefersDark: true, mode: "light", expected: "light" },
    { pref: "light", prefersDark: false, mode: "light", expected: "light" },
    { pref: "light", prefersDark: true, mode: "light", expected: "light" },
    { pref: "dark", prefersDark: false, mode: "light", expected: "light" },
    { pref: "dark", prefersDark: true, mode: "light", expected: "light" },
    // mode: user follows preference
    { pref: "light", prefersDark: false, mode: "user", expected: "light" },
    { pref: "light", prefersDark: true, mode: "user", expected: "light" },
    { pref: "dark", prefersDark: false, mode: "user", expected: "dark" },
    { pref: "dark", prefersDark: true, mode: "user", expected: "dark" },
    { pref: "system", prefersDark: false, mode: "user", expected: "light" },
    { pref: "system", prefersDark: true, mode: "user", expected: "dark" },
  ];

  for (const { pref, prefersDark, mode, expected } of cases) {
    const actual = resolveTheme(pref, prefersDark, mode);
    assert.equal(
      actual,
      expected,
      `resolveTheme(${pref}, ${prefersDark}, ${mode}) must be ${expected}, got ${actual}`
    );
  }
});

test("buildThemeInitScript executes in vm and applies expected attributes", () => {
  const script = buildThemeInitScript();

  function runScript(options: {
    pathname: string;
    storedPref?: string | null;
    throwOnStorage?: boolean;
    osDark?: boolean;
  }) {
    let recordedTheme: string | null = null;
    let recordedSurface: string | null = null;

    const fakeDoc = {
      documentElement: {
        setAttribute(k: string, v: string) {
          if (k === "data-theme") recordedTheme = v;
          if (k === "data-surface") recordedSurface = v;
        },
        removeAttribute(k: string) {
          if (k === "data-surface") recordedSurface = null;
          if (k === "data-theme") recordedTheme = null;
        },
      },
    };

    const fakeStorage = {
      getItem(k: string) {
        if (options.throwOnStorage) {
          throw new Error("Storage quota exceeded or disabled");
        }
        if (k === THEME_STORAGE_KEY) {
          return options.storedPref !== undefined ? options.storedPref : null;
        }
        return null;
      },
    };

    const fakeWin = {
      location: { pathname: options.pathname },
      localStorage: fakeStorage,
      matchMedia(q: string) {
        return {
          matches: q.includes("dark") ? Boolean(options.osDark) : false,
        };
      },
      document: fakeDoc,
    };

    const context = vm.createContext({
      window: fakeWin,
      location: fakeWin.location,
      localStorage: fakeWin.localStorage,
      matchMedia: fakeWin.matchMedia,
      document: fakeDoc,
    });

    vm.runInContext(script, context);

    return { recordedTheme, recordedSurface };
  }

  // Case 1: "/" + stored dark -> light, no surface
  {
    const res = runScript({ pathname: "/", storedPref: "dark", osDark: true });
    assert.equal(res.recordedTheme, "light");
    assert.equal(res.recordedSurface, null);
  }

  // Case 2: "/portal" + stored dark -> dark, app
  {
    const res = runScript({ pathname: "/portal", storedPref: "dark" });
    assert.equal(res.recordedTheme, "dark");
    assert.equal(res.recordedSurface, "app");
  }

  // Case 3: "/portal" + system + OS dark -> dark, app
  {
    const res = runScript({ pathname: "/portal", storedPref: null, osDark: true });
    assert.equal(res.recordedTheme, "dark");
    assert.equal(res.recordedSurface, "app");
  }

  // Case 4: "/ops/x" + stored dark -> light, app
  {
    const res = runScript({ pathname: "/ops/x", storedPref: "dark" });
    assert.equal(res.recordedTheme, "light");
    assert.equal(res.recordedSurface, "app");
  }

  // Case 5: throwing storage on "/portal" -> light, app
  {
    const res = runScript({ pathname: "/portal", throwOnStorage: true });
    assert.equal(res.recordedTheme, "light");
  }
});
