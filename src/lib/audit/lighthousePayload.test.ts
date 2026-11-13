// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/lighthousePayload.test.ts
//   src/server/lib/lighthouseStoredPayload.test.ts
//   src/server/lib/dataforseoLighthousePayload.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  buildLighthouseExportFile,
  buildStoredLighthouseIssues,
  buildStoredLighthouseMetrics,
  parseDataforseoLighthousePayload,
  readStoredLighthousePayload,
} from "./lighthousePayload.ts";

const issue = (category: string, auditKey: string) => ({
  category,
  auditKey,
  title: auditKey,
  description: "",
  score: 0,
  scoreDisplayMode: "binary",
  displayValue: null,
  impactMs: null,
  impactBytes: null,
  severity: "critical",
  items: [],
});

const metric = { score: null, displayValue: null, numericValue: null };

const storedPayloadJson = JSON.stringify({
  version: 2,
  source: "dataforseo-lighthouse",
  hasIssueDetails: true,
  metadata: {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    strategy: "mobile",
    fetchedAt: "2026-03-23T19:27:33.000Z",
    lighthouseVersion: null,
    taskId: null,
    cost: null,
  },
  scores: { performance: 89, accessibility: 93, "best-practices": 92, seo: 91 },
  metrics: {
    firstContentfulPaint: metric,
    largestContentfulPaint: metric,
    totalBlockingTime: metric,
    cumulativeLayoutShift: metric,
    speedIndex: metric,
    timeToInteractive: metric,
    interactionToNextPaint: metric,
    serverResponseTime: metric,
  },
  issues: [issue("performance", "unused-javascript"), issue("accessibility", "color-contrast")],
});

const issuesExportSchema = z.object({
  resultId: z.string(),
  category: z.string(),
  issues: z.array(z.object({ auditKey: z.string() })),
});

test("exports only the issues for issues and category modes", () => {
  for (const [mode, category, filename, exportedCategory, auditKeys] of [
    ["issues", undefined, "-issues.json", "all", ["unused-javascript", "color-contrast"]],
    ["category", "accessibility", "-accessibility-issues.json", "accessibility", ["color-contrast"]],
  ] as const) {
    const exported = buildLighthouseExportFile({
      idField: "resultId",
      idValue: "result-1",
      finalUrl: "https://example.com/",
      strategy: "mobile",
      createdAt: "2026-03-23T19:27:33.000Z",
      payloadJson: storedPayloadJson,
      mode,
      category,
    });
    const content = issuesExportSchema.parse(JSON.parse(exported.content));
    assert.ok(exported.filename.includes(filename));
    assert.equal(content.resultId, "result-1");
    assert.equal(content.category, exportedCategory);
    assert.deepEqual(content.issues.map((e) => e.auditKey), auditKeys);
    assert.ok(!exported.content.includes("timeToInteractive"));
  }
});

test("keeps actionable audits but separates metrics and diagnostics", () => {
  const audits = {
    interactive: { title: "Time to Interactive", score: 0.13, scoreDisplayMode: "numeric", displayValue: "12.8 s", numericValue: 12800 },
    "largest-contentful-paint-element": { title: "Largest Contentful Paint element", score: 0, scoreDisplayMode: "metricSavings", displayValue: "3,630 ms" },
    "unused-javascript": {
      title: "Reduce unused JavaScript",
      description: "Trim dead code.",
      score: 0.5,
      scoreDisplayMode: "metricSavings",
      displayValue: "Potential savings of 227 KiB",
      details: { overallSavingsBytes: 232886 },
    },
    "color-contrast": {
      title: "Background and foreground colors do not have a sufficient contrast ratio.",
      description: "Improve contrast.",
      score: 0,
      scoreDisplayMode: "binary",
    },
  };
  const categories = {
    performance: { auditRefs: [{ id: "interactive" }, { id: "largest-contentful-paint-element" }, { id: "unused-javascript" }] },
    accessibility: { auditRefs: [{ id: "color-contrast" }] },
    "best-practices": { auditRefs: [] },
    seo: { auditRefs: [] },
  };
  const issues = buildStoredLighthouseIssues({ audits, categories });
  const metrics = buildStoredLighthouseMetrics({ audits });
  assert.deepEqual(issues.issues.map((i) => i.auditKey), ["unused-javascript", "color-contrast"]);
  assert.equal(metrics.timeToInteractive.displayValue, "12.8 s");
  assert.equal(metrics.timeToInteractive.score, 13);
});

test("skips passing and non-actionable audits even when they appear in audit refs", () => {
  const audits = {
    passBinary: { title: "Serve images in next-gen formats", score: 1, scoreDisplayMode: "binary" },
    informative: { title: "User Timing marks and measures", score: 0, scoreDisplayMode: "informative" },
    manual: { title: "Structured data is valid", score: 0, scoreDisplayMode: "manual" },
    notApplicable: { title: "Uses optimized images", score: 0, scoreDisplayMode: "notApplicable" },
    errorAudit: { title: "`[accesskey]` values are unique", score: null, scoreDisplayMode: "error" },
    goodScore: { title: "Reduce unused CSS", score: 0.96, scoreDisplayMode: "metricSavings" },
  };
  const categories = {
    performance: { auditRefs: [{ id: "passBinary" }, { id: "informative" }, { id: "manual" }, { id: "notApplicable" }, { id: "goodScore" }] },
    accessibility: { auditRefs: [{ id: "errorAudit" }] },
    "best-practices": { auditRefs: [] },
    seo: { auditRefs: [] },
  };
  const issues = buildStoredLighthouseIssues({ audits, categories });
  assert.equal(issues.hasIssueDetails, true);
  assert.deepEqual(issues.issues, []);
});

test("compacts affected items and caps them at ten entries", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ url: `https://cdn.example.com/script-${i}.js`, wastedBytes: 1000 + i, extraField: "ignored" }));
  const issues = buildStoredLighthouseIssues({
    audits: {
      "unused-javascript": {
        title: "Reduce unused JavaScript",
        description: "Trim dead code.",
        score: 0,
        scoreDisplayMode: "metricSavings",
        details: { overallSavingsBytes: 50000, items },
      },
    },
    categories: {
      performance: { auditRefs: [{ id: "unused-javascript" }] },
      accessibility: { auditRefs: [] },
      "best-practices": { auditRefs: [] },
      seo: { auditRefs: [] },
    },
  });
  assert.equal(issues.issues.length, 1);
  assert.equal(issues.issues[0]?.items.length, 10);
  assert.equal(issues.issues[0]?.items[0], '{"url":"https://cdn.example.com/script-0.js","wastedBytes":1000}');
});

test("stores only issue-level lighthouse data and key metadata", () => {
  const parsed = parseDataforseoLighthousePayload(
    {
      status_code: 20000,
      status_message: "Ok.",
      tasks: [
        {
          id: "task-1",
          status_code: 20000,
          status_message: "Ok.",
          cost: 0.00425,
          result: [
            {
              requestedUrl: "https://everyapp.dev/",
              finalUrl: "https://everyapp.dev/",
              lighthouseVersion: "12.2.0",
              categories: {
                performance: { score: 0.54, auditRefs: [{ id: "unused-javascript" }] },
                accessibility: { score: 0.93, auditRefs: [] },
                "best-practices": { score: 0.79, auditRefs: [] },
                seo: { score: 0.92, auditRefs: [] },
              },
              audits: {
                "unused-javascript": {
                  title: "Reduce unused JavaScript",
                  description: "Trim dead code.",
                  score: 0,
                  scoreDisplayMode: "metricSavings",
                  displayValue: "Potential savings of 188 KiB",
                  numericValue: 193002,
                  details: { overallSavingsMs: 1270, overallSavingsBytes: 193002, items: [{ url: "https://cdn.example.com/app.js", wastedBytes: 193002 }] },
                },
                interactive: {
                  title: "Time to Interactive",
                  description: "Time until the page becomes interactive.",
                  score: 0.13,
                  scoreDisplayMode: "numeric",
                  displayValue: "12.8 s",
                  numericValue: 12800,
                },
              },
            },
          ],
        },
      ],
    },
    { url: "https://everyapp.dev/", strategy: "mobile" },
  );
  const { report } = readStoredLighthousePayload(JSON.stringify(parsed));
  assert.equal(parsed.metrics.timeToInteractive.displayValue, "12.8 s");
  assert.equal(parsed.scores.performance, 54);
  assert.equal(parsed.issues.length, 1);
  assert.ok(!parsed.issues.some((i) => i.auditKey === "interactive"));
  assert.equal(report.hasIssueDetails, true);
});

test("throws when the lighthouse response has no category scores", () => {
  assert.throws(() =>
    parseDataforseoLighthousePayload(
      {
        status_code: 20000,
        tasks: [
          {
            id: "task-1",
            status_code: 20000,
            cost: 0.00425,
            result: [
              {
                requestedUrl: "https://everyapp.dev/blog/category/cyber-security",
                finalUrl: "https://everyapp.dev/blog/category/cyber-security/",
                lighthouseVersion: "12.2.0",
                categories: {
                  performance: { score: null, auditRefs: [] },
                  accessibility: { score: null, auditRefs: [] },
                  "best-practices": { score: null, auditRefs: [] },
                  seo: { score: null, auditRefs: [] },
                },
                audits: {},
              },
            ],
          },
        ],
      },
      { url: "https://everyapp.dev/blog/category/cyber-security", strategy: "desktop" },
    ),
    /no category scores/,
  );
});

test("rejects a report whose audit fields are off-spec", () => {
  assert.throws(() =>
    parseDataforseoLighthousePayload(
      {
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{ categories: { performance: { score: 0.54, auditRefs: [{ id: "unused-javascript" }] } }, audits: { "unused-javascript": { title: 42, score: 0 } } }] }],
      },
      { url: "https://everyapp.dev/", strategy: "mobile" },
    ),
    /invalid report/,
  );
});

test("reads audits whose details.items is a single object", () => {
  const parsed = parseDataforseoLighthousePayload(
    {
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              categories: { performance: { score: 0.54, auditRefs: [{ id: "document-latency-insight" }] } },
              audits: { "document-latency-insight": { title: "Document request latency", score: 0, scoreDisplayMode: "metricSavings", details: { items: { url: "https://everyapp.dev/" } } } },
            },
          ],
        },
      ],
    },
    { url: "https://everyapp.dev/", strategy: "mobile" },
  );
  assert.deepEqual(parsed.issues.map((i) => i.auditKey), ["document-latency-insight"]);
  assert.deepEqual(parsed.issues[0]?.items, ['{"url":"https://everyapp.dev/"}']);
});
