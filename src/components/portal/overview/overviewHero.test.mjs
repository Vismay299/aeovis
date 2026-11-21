/**
 * The Overview hero's dial draws only what the latest scan measured: one tick
 * per question, lit for each question whose answers named the brand, and an
 * empty track with an em dash when there is no scan or no reading yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { compileJsx, renderToHtml, textOf } from "../../../server/renderHarness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadHero() {
  const model = await import("./overviewModel.js");
  return compileJsx(path.join(here, "OverviewHero.jsx"), {
    modules: new Map([
      ["react", React],
      ["next/dynamic", { __esModule: true, default: () => () => null }],
      ["@/components/app/motion/WordReveal", { WordReveal: ({ text }) => text }],
      ["@/components/app/motion/RollingNumber", { RollingNumber: ({ children }) => children }],
      ["./overviewModel", model],
    ]),
  });
}

const count = (html, re) => (html.match(re) || []).length;

test("dial: no scan draws no tick and no number, only an em dash and 'No scan yet'", async () => {
  const { VerdictDial } = await loadHero();
  const html = renderToHtml(VerdictDial, { latest: null });
  assert.equal(count(html, /class="ov-dial__tick"/g), 0);
  assert.match(html, /ov-dial__empty/);
  assert.match(textOf(html), /—/);
  assert.match(textOf(html), /No scan yet/);
  assert.doesNotMatch(textOf(html), /\d+%/);
});

test("dial: while the overview loads it says so and draws no reading", async () => {
  const { VerdictDial } = await loadHero();
  const html = renderToHtml(VerdictDial, { latest: null, loading: true });
  assert.equal(count(html, /class="ov-dial__tick"/g), 0);
  assert.match(textOf(html), /Reading your latest scan/);
  assert.doesNotMatch(textOf(html), /No scan yet/);
});

test("dial: one tick per tracked question, lit for each question that named the brand", async () => {
  const { VerdictDial } = await loadHero();
  const latest = { prompts_tracked: 30, prompts_mentioned: 11, visibility_pct: 36.7, scanned_at: "2026-11-20T10:00:00Z" };
  const html = renderToHtml(VerdictDial, { latest });
  assert.equal(count(html, /class="ov-dial__tick"/g), 30);
  assert.equal(count(html, /data-on="true"/g), 11);
  assert.match(textOf(html), /Named in 11 of 30 questions/);
  assert.match(textOf(html), /37/);
});

test("dial: a scan with no tracked questions is not drawn as a reading", async () => {
  const { VerdictDial } = await loadHero();
  const latest = { prompts_tracked: 0, prompts_mentioned: 0, visibility_pct: null, scanned_at: "2026-11-20T10:00:00Z" };
  const html = renderToHtml(VerdictDial, { latest });
  assert.equal(count(html, /class="ov-dial__tick"/g), 0);
  assert.match(textOf(html), /—/);
  assert.match(textOf(html), /Latest scan/);
  assert.doesNotMatch(textOf(html), /Named in/);
});
