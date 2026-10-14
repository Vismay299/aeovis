import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { compileJsx, renderToHtml, textOf } from "../../lib/renderHarness.mjs";
import * as scanProgress from "../../lib/scanProgress.js";
import * as reportData from "./scans/reportData.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const noop = () => {};
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Exercise async state and effect cleanup without adding a DOM dependency.
// Effects run after each render, and changing dependencies cleans up the old effect.
function createLifecycle() {
  const slots = [];
  let cursor = 0, changed = false, renderFn, output, effects;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    __esModule: true,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => {
        const value = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; changed = true; }
      }];
    },
    useRef(value) { const i = cursor++; return (slots[i] ??= { current: value }); },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useMemo(fn, deps) { return react.useCallback(fn, deps)(); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  react.default = react;
  return {
    react,
    get output() { return output; },
    setRender(fn) { renderFn = fn; changed = true; },
    render() {
      cursor = 0; effects = []; changed = false;
      output = renderFn();
      for (const effect of effects) effect();
      return output;
    },
    async settle() {
      for (let i = 0; i < 50; i++) {
        if (changed) this.render();
        await new Promise(setImmediate);
        if (!changed) return output;
      }
      assert.fail("Lifecycle did not settle; state/effects are looping.");
    },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function find(node, match) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, match); if (found) return found; }
    return null;
  }
  return match(node) ? node : find(node.props?.children, match);
}

async function trackerLifecycle(t, fetch) {
  const lifecycle = createLifecycle();
  t.after(() => lifecycle.close());
  t.mock.method(globalThis, "fetch", fetch);
  const { useScanTracker } = await compileJsx(path.join(here, "useScanTracker.js"), {
    modules: new Map([["react", lifecycle.react], ["@/lib/scanProgress", scanProgress]]),
  });
  return { lifecycle, useScanTracker };
}

test("a 404 scan is not re-adopted from stale or refreshed overview data", async (t) => {
  let requests = 0;
  const { lifecycle, useScanTracker } = await trackerLifecycle(t, async () => { requests++; return response(404, {}); });
  let jobs = [{ id: "gone", status: "probing", progress_pct: 40 }];
  lifecycle.setRender(() => useScanTracker({ brandKey: "brand-a", jobs }));
  await lifecycle.settle();
  assert.equal(requests, 1);
  assert.equal(lifecycle.output.active, false);
  jobs = jobs.map((job) => ({ ...job }));
  lifecycle.render(); await lifecycle.settle();
  assert.equal(requests, 1);
  jobs = [{ id: "another-gone", status: "pending" }, ...jobs];
  lifecycle.render(); await lifecycle.settle();
  assert.equal(requests, 2, "a different job can still be adopted");
});

for (const terminal of ["complete", "failed"]) {
  test(`a ${terminal} scan is not re-adopted, and a 409 adopts the next running scan`, async (t) => {
    const polled = [];
    let conflict = false;
    const { lifecycle, useScanTracker } = await trackerLifecycle(t, async (url, init) => {
      if (init?.method === "POST") { conflict = true; return response(409, {}); }
      polled.push(url);
      return url.includes("old-job")
        ? response(200, { status: terminal, result_id: "result-a" })
        : response(200, { status: "probing", progress_pct: 15 });
    });
    let jobs = [{ id: "old-job", status: "probing", progress_pct: 90 }];
    const onFinished = () => {
      if (conflict) {
        jobs = [{ id: "new-job", status: "probing", progress_pct: 15 }, ...jobs];
      }
    };
    lifecycle.setRender(() => useScanTracker({ brandKey: "brand-a", jobs, onFinished }));
    await lifecycle.settle();
    assert.equal(lifecycle.output.job.status, terminal);
    assert.equal(polled.length, 1, "stale overview must not resurrect the terminal scan");
    await lifecycle.output.start(); await lifecycle.settle();
    assert.equal(lifecycle.output.job.id, "new-job");
    assert.equal(lifecycle.output.active, true);
    assert.equal(lifecycle.output.percent, 15, "a new scan resets the old percentage");
    assert.equal(lifecycle.output.finished, null);
    assert.ok(polled.some((url) => url.includes("new-job")));
  });
}

async function draftLifecycle(t, request) {
  const lifecycle = createLifecycle();
  t.after(() => lifecycle.close());
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { addEventListener: noop, removeEventListener: noop, confirm: () => true }, configurable: true });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  const ui = Object.fromEntries(["Badge", "Banner", "Button", "Skeleton", "Tabs"].map((key) => [key, noop]));
  ui.formatRelative = () => "just now";
  const review = await compileJsx(path.join(here, "content/ReviewFindings.jsx"), {
    modules: new Map([["react", lifecycle.react], ["../ui", ui]]),
  });
  const { default: DraftEditor } = await compileJsx(path.join(here, "content/DraftEditor.jsx"), {
    modules: new Map([
      ["react", lifecycle.react], ["../ui", ui],
      ["./shared", { contentRequest: request, countWords: () => 1, readingMinutes: () => 1, cx: (...parts) => parts.filter(Boolean).join(" "), playbookLabel: () => "" }],
      ["../status", { contentItemStatus: () => ({ label: "Needs review" }) }],
      ["@/components/studio/Markdown", { Markdown: noop }],
      ["./ReviewFindings", review],
    ]),
    autoNull: ["lucide-react"],
  });
  const props = { brandKey: "brand-a", itemId: "draft-a", generating: false, onChanged: noop, onUnauthorized: noop, onDirtyChange: noop };
  lifecycle.setRender(() => DraftEditor(props));
  await lifecycle.settle();
  return {
    lifecycle,
    field: (type) => find(lifecycle.output, (node) => node.type === type),
    save: () => find(lifecycle.output, (node) => node.props?.children?.includes("Save changes")).props.onClick(),
  };
}

test("draft fields stay locked during both PATCH and refresh, then unlock with saved text", async (t) => {
  const patch = deferred(), refresh = deferred();
  let server = { id: "draft-a", title: "Draft", body_md: "Original", status: "awaiting_approval" };
  let reads = 0;
  const { lifecycle, field, save } = await draftLifecycle(t, async (url, options = {}) => {
    if (options.method === "PATCH") { await patch.promise; server = { ...server, ...options.body }; return { saved: true }; }
    if (++reads > 1) await refresh.promise;
    return { item: server };
  });
  field("textarea").props.onChange({ target: { value: "Edited body" } });
  await lifecycle.settle();
  const saving = save(); await lifecycle.settle();
  assert.equal(field("textarea").props.readOnly, true);
  assert.equal(field("input").props.readOnly, true);
  patch.resolve(); await lifecycle.settle();
  assert.equal(field("textarea").props.readOnly, true, "refresh must remain locked too");
  refresh.resolve(); await saving; await lifecycle.settle();
  assert.equal(field("textarea").props.value, "Edited body");
  assert.equal(field("textarea").props.readOnly, false);
});

test("a failed draft save unlocks fields and preserves the local edits", async (t) => {
  const { lifecycle, field, save } = await draftLifecycle(t, async (url, options = {}) => {
    if (options.method === "PATCH") throw new Error("Network unavailable");
    return { item: { title: "Draft", body_md: "Original", status: "awaiting_approval" } };
  });
  field("textarea").props.onChange({ target: { value: "Unsaved body" } }); await lifecycle.settle();
  await save(); await lifecycle.settle();
  assert.equal(field("textarea").props.value, "Unsaved body");
  assert.equal(field("textarea").props.readOnly, false);
});

test("engine visibility uses current worker summaries, including measured zero, with legacy fallback", () => {
  assert.deepEqual(reportData.readEngineScores({ aio: 99 }, {
    aio: { engine: "aio", visibility_pct: 42 },
    chatgpt: { engine: "chatgpt", visibility_pct: 0 },
    perplexity: { engine: "perplexity", visibility_pct: null, state: "never_ran" },
  }), [{ name: "aio", pct: 42 }, { name: "chatgpt", pct: 0 }]);
  assert.deepEqual(reportData.readEngineScores({ aio: 25 }, null), [{ name: "aio", pct: 25 }]);
  assert.deepEqual(reportData.readEngineScores(null, [{ engine: "chatgpt", visibility_pct: 12 }]), [{ name: "chatgpt", pct: 12 }]);
});

test("the report renders its By engine card from the actual worker payload shape", async (t) => {
  const lifecycle = createLifecycle();
  t.after(() => lifecycle.close());
  const engineData = { aio: { engine: "aio", visibility_pct: 42 }, chatgpt: { engine: "chatgpt", visibility_pct: 0 } };
  t.mock.method(globalThis, "fetch", async () => response(200, { scan: { id: "scan-a", engines: engineData, engine_scores: null }, results: [] }));
  const nextLink = { __esModule: true, default: "a" };
  const ui = await compileJsx(path.join(here, "ui.jsx"), { modules: new Map([["next/link", nextLink]]), autoNull: ["lucide-react"] });
  const cards = await compileJsx(path.join(here, "scans/ReportCards.jsx"), { modules: new Map([["react", React], ["../ui", ui], ["./reportData", reportData], ["./scans.css", {}]]), autoNull: ["lucide-react"] });
  const { default: ReportPage } = await compileJsx(path.join(here, "../../app/portal/scans/[scanId]/page.jsx"), {
    modules: new Map([
      ["react", lifecycle.react], ["next/navigation", { useParams: () => ({ scanId: "scan-a" }) }],
      ["@/components/portal/PortalShell", { usePortal: () => ({ redirectToLogin: noop }) }],
      ["@/components/portal/ui", ui], ["@/components/portal/scans/ReportCards", cards],
      ["@/components/portal/scans/reportData", reportData], ["@/components/portal/scans/scans.css", {}],
    ]), autoNull: ["lucide-react"],
  });
  lifecycle.setRender(() => ReportPage()); await lifecycle.settle();
  const card = find(lifecycle.output, (node) => node.type === cards.EngineScoresCard);
  assert.ok(card, "report must not hide the card when engine_scores is absent");
  const html = textOf(renderToHtml(cards.EngineScoresCard, card.props));
  assert.match(html, /By engine/);
  assert.match(html, /42%/);
  assert.match(html, /0%/);
});


test("a failed engine is visibly unmeasured even when an older score field contains a number", async () => {
  const ui = await compileJsx(path.join(here, "ui.jsx"), { modules: new Map([["react", React]]), autoNull: ["lucide-react", "next/link"] });
  const cards = await compileJsx(path.join(here, "scans/ReportCards.jsx"), { modules: new Map([["react", React], ["../ui", ui], ["./reportData", reportData], ["./scans.css", {}]]), autoNull: ["lucide-react"] });
  const html = renderToHtml(cards.EngineScoresCard, { engineScores: { aio: 73 }, engines: { aio: { visibility_pct: 73, non_branded_queries: 30, non_branded_with_answer: 7, errored_queries: 26, data_source_issue: true } } });
  const text = textOf(html);
  assert.ok(text.includes("Collection incomplete"));
  assert.ok(text.includes("7 of 30 questions answered"));
  assert.ok(text.includes("26 collection errors"));
  assert.ok(!text.includes("73%"));
});


test("failed engine slices remain in the report even when their visibility is correctly null",()=>{
  assert.deepEqual(reportData.readEngineScores(null,{aio:{visibility_pct:null,data_source_issue:true}}),[{name:"aio",pct:null}]);
});

test("collection failures are not counted as measured missing-brand answers", async () => {
  const ui = await compileJsx(path.join(here, "ui.jsx"), { modules: new Map([["react", React]]), autoNull: ["lucide-react", "next/link"] });
  const cards = await compileJsx(path.join(here, "scans/ReportCards.jsx"), { modules: new Map([["react", React], ["../ui", ui], ["./reportData", reportData], ["./scans.css", {}]]), autoNull: ["lucide-react"] });
  const results = [
    { query: "named brand", engine: "chatgpt", answered: true, mentioned: true },
    { query: "measured gap", engine: "chatgpt", answered: true, mentioned: false },
    { query: "failed capture", engine: "chatgpt", answered: true, mentioned: true, raw: { error: "Provider key limit exceeded" } },
    { query: "natural absence", engine: "aio", answered: false, mentioned: false },
  ];
  const text = textOf(renderToHtml(cards.QuestionsCard, { results }));
  assert.match(text, /Naming you 1/);
  assert.match(text, /Not naming you 1/);
  assert.match(text, /No answers 2/);
  assert.match(text, /ChatGPT: Collection failed/);
  assert.match(text, /Google AI Overviews: No answer/);
  const failed = reportData.groupQuestions(results)[2];
  assert.equal(reportData.questionNamesBrand(failed, "all"), false);
  assert.equal(reportData.questionHasAnswer(failed, "all"), false);
});

test("healthy low-sample answers keep their measured score and do not appear as collection failures", async () => {
  const ui = await compileJsx(path.join(here, "ui.jsx"), { modules: new Map([["react", React]]), autoNull: ["lucide-react", "next/link"] });
  const cards = await compileJsx(path.join(here, "scans/ReportCards.jsx"), { modules: new Map([["react", React], ["../ui", ui], ["./reportData", reportData], ["./scans.css", {}]]), autoNull: ["lucide-react"] });
  const text = textOf(renderToHtml(cards.EngineScoresCard, { engines: {
    gemini: { visibility_pct: 0, data_source_issue: false, insufficient_sample: true, eliciting_queries: 4, non_branded_queries: 30, non_branded_with_answer: 30, errored_queries: 0 },
    chatgpt: { visibility_pct: null, data_source_issue: false, insufficient_sample: true, eliciting_queries: 0, non_branded_queries: 30, non_branded_with_answer: 30, errored_queries: 0 },
  } }));
  assert.match(text, /0%/);
  assert.match(text, /Limited scoring sample · 4 answers named a tracked brand/);
  assert.match(text, /Treat this score as low confidence/);
  assert.match(text, /Limited scoring sample · 0 answers named a tracked brand/);
  assert.match(text, /Visibility is not assessed/);
  assert.doesNotMatch(text, /Collection incomplete|collection errors/);
});

test("an unmeasured engine row draws a still 'not measured' rail, not a loading sweep", async () => {
  const ui = await compileJsx(path.join(here, "ui.jsx"), { modules: new Map([["react", React]]), autoNull: ["lucide-react", "next/link"] });
  const cards = await compileJsx(path.join(here, "scans/ReportCards.jsx"), { modules: new Map([["react", React], ["../ui", ui], ["./reportData", reportData], ["./scans.css", {}]]), autoNull: ["lucide-react"] });
  const html = renderToHtml(cards.EngineScoresCard, { engines: {
    aio: { visibility_pct: null, data_source_issue: true, non_branded_queries: 30, non_branded_with_answer: 0, errored_queries: 30 },
  } });
  assert.match(html, /By engine/);
  assert.doesNotMatch(html, /pv-progress--indeterminate/, "an unmeasured engine must not run a loading sweep forever");
  assert.match(html, /pv-progress--unmeasured/, "and must not read as a measured 0% bar");
  assert.match(html, /aria-label="Google AI Overviews score: not measured"/);
  assert.doesNotMatch(html, /pv-progress__fill/, "an unmeasured bar draws no fill");
  assert.doesNotMatch(html, /aria-valuenow/);
});

test("a history bar is pending only before finalization, not when collection failed", () => {
  assert.equal(reportData.scanVisibilityState({ visibility_pct: 42 }), "measured");
  assert.equal(reportData.scanVisibilityState({ visibility_pct: 0 }), "measured");
  assert.equal(reportData.scanVisibilityState({ visibility_pct: null, collection_partial: true }), "unmeasured");
  assert.equal(reportData.scanVisibilityState({ visibility_pct: null, collection_partial: false }), "pending");
  assert.equal(reportData.scanVisibilityState({}), "pending");
});

test("a completed healthy scan with no elicited brands renders an unmeasured history bar", async () => {
  const { summarizeEngineSlice, summarizeEngineResults, computeHeadline } = await import("../../lib/scoring/enginePipeline.js");
  const results = Array.from({ length: 30 }, (_, i) => ({
    query: `unbranded question ${i}`, is_branded_query: false,
    answer_present: true, error: null, text: "An answer without vendor names",
    visible: false, brand_mentioned_in_text: false, brand_cited: false,
    brands: [
      { name: "Self", is_self: true, mentioned: false },
      { name: "Rival", is_self: false, mentioned: false },
    ],
  }));
  const engines = Object.fromEntries(["aio", "chatgpt", "perplexity", "gemini"].map((name) => [name, summarizeEngineSlice(results, name)]));
  const { summary } = summarizeEngineResults({ results, engines, headline: computeHeadline(Object.values(engines)) });
  const scan = {
    visibility_pct: summary.visibility_pct,
    scanned_at: "2026-10-14T10:00:00Z",
    collection_partial: Object.values(engines).some((slice) => slice.data_source_issue === true || slice.error_rate_pct > 0),
  };
  assert.equal(scan.visibility_pct, null);
  assert.equal(scan.collection_partial, false);
  assert.equal(reportData.scanVisibilityState(scan), "unmeasured");
  const ui = await compileJsx(path.join(here, "ui.jsx"), { modules: new Map([["react", React]]), autoNull: ["lucide-react", "next/link"] });
  const html = renderToHtml(ui.ProgressBar, {
    value: scan.visibility_pct, indeterminate: reportData.scanVisibilityState(scan) === "pending",
    size: "sm", label: "AI visibility",
  });
  assert.match(html, /aria-label="AI visibility: not measured"/);
  assert.match(html, /pv-progress--unmeasured/);
  assert.doesNotMatch(html, /pv-progress--indeterminate|pv-progress__fill/);
});
