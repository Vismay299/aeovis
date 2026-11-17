import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { compileJsx, renderToHtml } from "./renderHarness.mjs";
const root = path.resolve(import.meta.dirname, "../..");

test("first server paint is light and dark mode is confined to app paths", async () => {
  const themeModule = await import("../shared/theme/theme.ts");
  const nullComp = () => null;
  const stubModule = { default: nullComp, SurfaceSync: nullComp, AppToaster: nullComp, __esModule: true };
  const { default: Layout } = await compileJsx(path.join(root, "src/app/layout.js"), {
    modules: new Map([
      ["@/components/app/theme/SurfaceSync", stubModule],
      ["@/components/app/AppToaster", stubModule],
      ["@/shared/theme/theme", themeModule],
    ]),
    autoNull: ["./globals.css", "@/components/design-system/primitives.css", "@/components/portal/portal.css"],
  });
  const html = renderToHtml(Layout, { children: "Workspace" });
  assert.match(html, /<html[^>]*data-theme="light"/);

  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "init script must be present in layout html");
  const expectedScript = themeModule.buildThemeInitScript();
  assert.equal(scriptMatch[1], expectedScript);

  const vm = await import("node:vm");
  let recordedTheme = null;
  let recordedSurface = null;
  const fakeDoc = {
    documentElement: {
      setAttribute(k, v) {
        if (k === "data-theme") recordedTheme = v;
        if (k === "data-surface") recordedSurface = v;
      },
      removeAttribute(k) {
        if (k === "data-surface") recordedSurface = null;
        if (k === "data-theme") recordedTheme = null;
      },
    },
  };
  const fakeWin = {
    location: { pathname: "/" },
    localStorage: {
      getItem(k) {
        if (k === themeModule.THEME_STORAGE_KEY) return "dark";
        return null;
      },
    },
    matchMedia() {
      return { matches: false };
    },
    document: fakeDoc,
  };
  const ctx = vm.createContext({
    window: fakeWin,
    location: fakeWin.location,
    localStorage: fakeWin.localStorage,
    matchMedia: fakeWin.matchMedia,
    document: fakeDoc,
  });
  vm.runInContext(scriptMatch[1], ctx);
  assert.equal(recordedTheme, "light");
  assert.equal(recordedSurface, null);

  await assert.rejects(access(path.join(root, "src/components/perceev/ThemeToggle.jsx")));
});

test("public and customer controls share primitive rules instead of independent styles", async () => {
  const css = await readFile(path.join(root, "src/components/design-system/primitives.css"), "utf8");
  assert.match(css, /\.btn, \.pv-btn \{/);
  assert.match(css, /\.card, \.panel, \.pv-card \{/);
  assert.match(css, /\.chip, \.pv-badge \{/);
  assert.match(css, /\.inp, \.pv-input, \.pv-select, \.pv-textarea \{/);
  const portal = await readFile(path.join(root, "src/components/portal/portal.css"), "utf8");
  assert.doesNotMatch(portal, /^\.pv-btn \{/m);
  assert.doesNotMatch(portal, /^\.pv-card \{/m);
  const globals = await readFile(path.join(root, "src/app/globals.css"), "utf8");
  assert.ok(!globals.includes(".customer-portal-page"));
});
