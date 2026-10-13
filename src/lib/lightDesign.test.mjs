import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { compileJsx, renderToHtml } from "./renderHarness.mjs";
const root = path.resolve(import.meta.dirname, "../..");

test("first server paint is light and cannot restore an old dark preference", async () => {
  const themes = [];
  const { default: Layout } = await compileJsx(path.join(root, "src/app/layout.js"), {
    modules: new Map([["sonner", { Toaster: ({ theme }) => { themes.push(theme); return null; } }]]),
    autoNull: ["./globals.css", "@/components/design-system/primitives.css", "@/components/portal/portal.css"],
  });
  const html = renderToHtml(Layout, { children: "Workspace" });
  assert.match(html, /<html[^>]*data-theme="light"/);
  assert.deepEqual(themes, ["light"]);
  assert.ok(!html.includes("localStorage"));
  const css = await readFile(path.join(root, "src/app/globals.css"), "utf8");
  assert.ok(!css.includes("prefers-color-scheme"));
  assert.ok(!css.includes('data-theme="dark"'));
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
