/**
 * T9 — the Overview data cards render the overview's `dailyMentions` and
 * `engines` honestly: days without a scan stay gaps, comparisons name how many
 * scans they compare, and no sample data ever reaches the product.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { compileJsx, renderToHtml, textOf } from "../../../server/renderHarness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const kokonut = path.join(here, "../../kokonutui");

const END = "2026-11-20";
const DAY = 86_400_000;
const dateAgo = (n) => new Date(Date.parse(`${END}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
const calendar = () => Array.from({ length: 90 }, (_, i) => dateAgo(89 - i));

/**
 * An overview shaped like the API: 90 calendar days, scans on a few of them.
 * `scans` maps days-ago to { mentioned, byEngine, states }.
 */
function overviewWith(scans, engines = ["chatgpt", "gemini", "perplexity"]) {
  const dates = calendar();
  const on = (date) => scans[Math.round((Date.parse(`${END}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY)];
  return {
    scans: [],
    dailyMentions: dates.map((date) => ({
      date,
      mentioned: on(date)?.mentioned ?? null,
      byEngine: Object.fromEntries(engines.map((e) => [e, on(date)?.byEngine?.[e] ?? null])),
    })),
    engines: engines.map((engine) => ({
      engine,
      days: dates.map((date) => ({ date, state: on(date)?.states?.[engine] ?? null })),
    })),
  };
}

const SPARSE = {
  40: { mentioned: 6, byEngine: { chatgpt: 5, gemini: 2 }, states: { chatgpt: "measured", gemini: "measured", perplexity: "not_assessed" } },
  5: { mentioned: 8, byEngine: { chatgpt: 6, gemini: 3 }, states: { chatgpt: "measured", gemini: "measured_zero", perplexity: "not_assessed" } },
  0: { mentioned: 12, byEngine: { chatgpt: 9 }, states: { chatgpt: "measured", gemini: "failed", perplexity: "measured" } },
};

const uiStub = {
  Card: ({ title, description, children }) =>
    React.createElement("section", { "data-card": "" }, title ? React.createElement("h2", null, title) : null,
      description ? React.createElement("p", null, description) : null, children),
  EmptyState: ({ title, children }) =>
    React.createElement("div", { "data-empty": "" }, React.createElement("p", null, title), React.createElement("p", null, children)),
  Skeleton: () => React.createElement("div", { "data-skeleton": "" }),
};

async function load() {
  const utils = await import("../../../shared/utils.ts");
  const shared = { autoNull: ["lucide-react"], typescript: true };
  const metric = await compileJsx(path.join(kokonut, "metric-card.tsx"), {
    ...shared,
    modules: new Map([["react", React], ["@/shared/utils", utils]]),
    exposeInternals: ["buildPeriod", "readOf"],
  });
  const uptime = await compileJsx(path.join(kokonut, "uptime-card.tsx"), {
    ...shared,
    modules: new Map([["react", React], ["@/shared/utils", utils]]),
  });
  const model = await import("./overviewModel.js");
  const reportData = await import("../scans/reportData.js");
  const cards = await compileJsx(path.join(here, "EngineCards.jsx"), {
    modules: new Map([
      ["react", React],
      ["@/components/kokonutui/metric-card", metric],
      ["@/components/kokonutui/uptime-card", uptime],
      ["@/components/portal/scans/reportData", reportData],
      ["../ui", uiStub],
      ["./overviewModel", model],
    ]),
    autoNull: ["lucide-react"],
  });
  return { EngineCards: cards.default, MetricCard: metric.default, metric };
}

const SAMPLE_WORDS = /Revenue|Plans|Services|Webhooks|Dashboard|System status|Operational|incident|Fall promo|New pricing|uptime/i;

test("sparse scans render as gaps with honest counts, and failed and unassessed days apart", async () => {
  const { EngineCards } = await load();
  const html = renderToHtml(EngineCards, { overview: overviewWith(SPARSE) });
  const text = textOf(html);

  assert.match(text, /Answers naming you/);
  assert.match(text, /Answer engines/);
  assert.doesNotMatch(text, SAMPLE_WORDS);
  assert.doesNotMatch(html, /NaN|undefined/);

  // Opens on 7 days, which holds two scans; the period before holds none.
  assert.match(text, /Avg of 2 scans in 7 days/);
  assert.match(text, /none before to compare/);
  assert.doesNotMatch(text, /[▲▼]|%/);
  // Only the scan days get a dot: the five unscanned days between are gaps.
  assert.deepEqual([...html.matchAll(/data-scan-day="([^"]+)"/g)].map((m) => m[1]), [dateAgo(5), dateAgo(0)]);
  // Two scans five days apart are not joined by a line.
  assert.doesNotMatch(html, /class="fill-none stroke-primary"[^>]*d="M/);

  assert.match(text, /ChatGPT Measured on 3 of 90 days/);
  assert.match(text, /Gemini Measured on 2 of 90 days · failed on 1/);
  assert.match(text, /Perplexity Measured on 1 of 90 days/);
  assert.match(text, /1 of 3 failed on Nov 20/);
  const statuses = [...html.matchAll(/data-status="(\w+)"/g)].map((m) => m[1]);
  const count = (s) => statuses.filter((x) => x === s).length;
  assert.equal(statuses.length, 270);
  assert.equal(count("up"), 6);
  assert.equal(count("down"), 1);
  assert.equal(count("unassessed"), 2);
  assert.equal(count("none"), 270 - 9);
});

test("scans on consecutive days are joined by a line", async () => {
  const { MetricCard } = await load();
  const { mentionSeries } = await import("./overviewModel.js");
  const data = mentionSeries(overviewWith({ 2: { mentioned: 4 }, 1: { mentioned: 6 } }));
  const html = renderToHtml(MetricCard, { label: "Answers naming you", data, defaultPeriod: 7 });
  assert.match(html, /class="fill-none stroke-primary"[^>]*d="M/);
});

test("a period comparison names the scans on each side and drops days without one", async () => {
  const { MetricCard } = await load();
  const { mentionSeries } = await import("./overviewModel.js");
  const overview = overviewWith({
    50: { mentioned: 4 },
    40: { mentioned: 6 },
    20: { mentioned: 0 },
    3: { mentioned: 10 },
  });
  const html = renderToHtml(MetricCard, { label: "Answers naming you", data: mentionSeries(overview), defaultPeriod: 30 });
  const text = textOf(html);
  // (0 + 10) / 2 = 5 now, (4 + 6) / 2 = 5 before: a zero scan counts, an empty day does not.
  assert.match(text, /Avg of 2 scans in 30 days, vs 2 in the 30 before/);
  assert.match(text, /▲ 0\.0%/);
});

test("reading a day with no scan says so and compares nothing", async () => {
  const { metric } = await load();
  const { mentionSeries } = await import("./overviewModel.js");
  const data = mentionSeries(overviewWith({ 10: { mentioned: 3 }, 3: { mentioned: 7 }, 2: { mentioned: 5 } }));
  const info = metric.buildPeriod(data, 7, null);
  const empty = metric.readOf(info, { lo: 0, hi: 0 }, false, 7, []);
  assert.equal(empty.value, null);
  assert.equal(empty.change, null);
  assert.match(empty.caption, /No scan$/);
  assert.equal(empty.comparison, null);

  // A range averages its scan days only: (7 + 5) / 2, not / 7.
  const range = metric.readOf(info, { lo: 0, hi: 6 }, true, 7, []);
  assert.equal(range.value, 6);
  assert.match(range.caption, /avg of 2 scans$/);
  // The 7 days before hold one scan (10 days ago), so this range compares.
  assert.equal(range.comparison, "vs 1 before");
});

test("a workspace with no scan history gets the empty state, not a chart", async () => {
  const { EngineCards } = await load();
  const html = renderToHtml(EngineCards, { overview: overviewWith({}, []) });
  const text = textOf(html);
  assert.match(text, /Your history appears after your first scan/);
  assert.doesNotMatch(html, /<svg|data-status|data-scan-day/);
  assert.doesNotMatch(text, SAMPLE_WORDS);

  // An older API without the fields renders the same empty state.
  assert.match(textOf(renderToHtml(EngineCards, { overview: { scans: [] } })), /Your history appears after your first scan/);
});

test("while the overview loads, the cards show skeletons", async () => {
  const { EngineCards } = await load();
  const html = renderToHtml(EngineCards, { overview: null });
  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/data-skeleton/g) || []).length, 2);
});
