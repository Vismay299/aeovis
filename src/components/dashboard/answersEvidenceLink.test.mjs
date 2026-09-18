/**
 * R1.5.3 — the "View evidence" affordance in AnswersView.
 *
 * Two halves, deliberately:
 *   1. The PREDICATE (`evidenceScreenshotHref`) is exercised directly. It is the
 *      one place that decides whether the affordance exists and what it points
 *      at, so it is tested as a function rather than inferred from markup.
 *   2. The RENDER is exercised through the real component with
 *      renderToStaticMarkup — the same harness as answersEngineFilters.test.mjs
 *      (compile the .jsx with sucrase, resolve only the imports the file really
 *      has). This is what proves the predicate is actually wired to a link the
 *      DOM receives, and not merely exported.
 *
 * THE ANTI-VACUITY PAIR: every "renders" assertion has a matching "does not
 * render" one on the same fixture with one field removed. A component that
 * always showed the button, or never did, fails one of each pair.
 *
 * WHAT IT CANNOT PROVE: no browser, no click, no network. It shows the href in
 * the markup is the route's path. That the route answers correctly is
 * src/lib/evidenceSignedUrl.route.test.mjs, at the real handler.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync as read } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import * as interlockingModule from "./interlocking.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS_PATH = path.join(HERE, "AnswersView.jsx");

function nullComponent() {
  return null;
}

const anyNamedExport = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return nullComponent;
    },
  }
);

function loadAnswersView() {
  const source = read(ANSWERS_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: ANSWERS_PATH,
  });
  const reactModule = { ...React, __esModule: true };
  reactModule.default = reactModule;
  const modules = new Map([
    ["react", reactModule],
    ["lucide-react", anyNamedExport],
    ["./interlocking", { ...interlockingModule, __esModule: true }],
  ]);
  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    throw new Error(`AnswersView.jsx imports "${specifier}", which this harness does not resolve — add it deliberately.`);
  };
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, mod, mod.exports, React);
  return mod.exports;
}

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RESULT_ID = "22222222-2222-4222-8222-222222222222";
const SCREENSHOT_KEY = `${JOB_ID}/perplexity/${RESULT_ID}.png`;

/** A selected answer that HAS a stored capture. */
const WITH_EVIDENCE = {
  prompt: "best crm for hospitals",
  engine: "perplexity",
  aioPresent: true,
  visible: false,
  aioText: "Rival Co is the usual pick.",
  jobId: JOB_ID,
  resultId: RESULT_ID,
  evidenceScreenshotId: SCREENSHOT_KEY,
};

function render(prompts) {
  const { AnswersView } = loadAnswersView();
  assert.equal(typeof AnswersView, "function", "AnswersView.jsx must still export the component");
  return renderToStaticMarkup(React.createElement(AnswersView, { prompts }));
}

const { evidenceScreenshotHref } = loadAnswersView();

test("R1.5.3 — the predicate builds the route path for a row with a stored capture", () => {
  assert.equal(
    evidenceScreenshotHref(WITH_EVIDENCE),
    `/api/scan/${JOB_ID}/evidence?result=${RESULT_ID}&kind=screenshot`
  );
});

test("R1.5.3 — the stored object key is NEVER put in the URL", () => {
  const href = evidenceScreenshotHref(WITH_EVIDENCE);
  assert.doesNotMatch(href, /\.png/, "the object key must not travel in the query string");
  assert.ok(!href.includes(SCREENSHOT_KEY));
});

test("R1.5.3 — NULL / empty / missing screenshot id yields no href", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(
      evidenceScreenshotHref({ ...WITH_EVIDENCE, evidenceScreenshotId: value }),
      null,
      `evidenceScreenshotId ${JSON.stringify(value)} must not produce a link`
    );
  }
});

test("R1.5.3 — a row with no addressable identity yields no href", () => {
  assert.equal(evidenceScreenshotHref({ ...WITH_EVIDENCE, jobId: null }), null);
  assert.equal(evidenceScreenshotHref({ ...WITH_EVIDENCE, resultId: null }), null);
  assert.equal(evidenceScreenshotHref(null), null);
});

test("R1.5.3 — the ids are URL-encoded, so a hostile id cannot escape the path", () => {
  const href = evidenceScreenshotHref({ ...WITH_EVIDENCE, jobId: "a/../../etc", resultId: "b&kind=raw" });
  assert.ok(!href.includes("a/../../etc"), "a path separator must be encoded");
  assert.ok(!href.includes("b&kind=raw"), "a second parameter must not be smuggled in");
  assert.match(href, /kind=screenshot$/);
});

test("R1.5.3 — the selected answer renders a 'View evidence' link to the route", () => {
  const html = render([WITH_EVIDENCE]);
  assert.match(html, /View evidence/, "the affordance must reach the DOM");
  assert.match(
    html,
    new RegExp(`href="/api/scan/${JOB_ID}/evidence\\?result=${RESULT_ID}&(amp;)?kind=screenshot"`),
    "the link must point at the evidence route for this row"
  );
  assert.match(html, /data-testid="view-evidence-link"/);
  assert.match(html, /target="_blank"/, "it opens in a new tab");
  assert.match(html, /rel="noopener noreferrer"/);
});

test("R1.5.3 — an answer with no stored capture renders NO link at all", () => {
  const html = render([{ ...WITH_EVIDENCE, evidenceScreenshotId: null }]);
  assert.doesNotMatch(html, /View evidence/, "no capture, no button — never a link to a 404");
  assert.doesNotMatch(html, /view-evidence-link/);
  assert.doesNotMatch(html, /\/evidence\?result=/);
});

test("R1.5.3 — only the SELECTED answer's link is rendered, and it is that row's own", () => {
  const second = {
    ...WITH_EVIDENCE,
    prompt: "hospital crm comparison",
    resultId: "33333333-3333-4333-8333-333333333333",
  };
  const html = render([WITH_EVIDENCE, second]);
  const hrefs = [...html.matchAll(/\/api\/scan\/[^"]*evidence\?result=([0-9a-f-]+)/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [RESULT_ID], "the verbatim panel shows one link, for the row on screen");
});
