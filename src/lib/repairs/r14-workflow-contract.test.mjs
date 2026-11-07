import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePanel,
  matchesBrandAlias,
  verifySourcePassage,
  makeSourceSnapshot,
  draftCheck,
  checkMatches,
  verifyBodyMatch,
  opportunityFromEvidence,
} from "./workflow.js";
import {
  researchEvidence,
  bindResearchCheck,
  isCurrentCheck,
} from "./researchContract.js";
import { reportResponseState } from "../reportViewState.js";
import {
  summarizeEngineSlice,
  computeHeadline,
} from "../scoring/enginePipeline.js";
import {
  evidenceDocument,
  createMeasurementEvidenceStore,
} from "../db/measurementEvidence.js";
import { METRIC_IDS } from "../scoring/metricContract.js";
test("R14: purpose and exact panel identities freeze before answers; duplicate and invented weights refused", () => {
  const p = validatePanel(
    {
      context: { country: "in" },
      persona: "IT buyers",
      prompts: [
        { text: "Which vendor supports database recovery?", origin: "manual" },
        { text: "What is Acme pricing?", origin: "manual" },
      ],
    },
    { brandAliases: ["Acme"] },
  );
  assert.equal(p.prompts[0].purpose, "recommendation");
  assert.equal(p.prompts[1].purpose, "diagnostic");
  assert.equal(p.prompts[0].weight, 1);
  assert.equal(p.prompts[0].demand_estimate, null);
  assert.throws(
    () => validatePanel({ ...p, prompts: [p.prompts[0], p.prompts[0]] }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validatePanel({
        ...p,
        prompts: [
          { ...p.prompts[0], weight: 2, weight_reason: "unsupported bias" },
        ],
      }),
    /equal/,
  );
  assert.throws(
    () => validatePanel({ ...p, context: { country: "zz" } }),
    /country/,
  );
});
test("search_questions is accepted as a conventional question origin without evidence", () => {
  const panel = validatePanel({
    persona: "Small business buyers",
    context: { country: "in" },
    prompts: [{ text: "Which invoicing tools suit small teams?", origin: "search_questions" }],
  });
  assert.equal(panel.prompts[0].origin, "search_questions");
  assert.equal(panel.prompts[0].purpose, "recommendation");
  assert.equal(panel.prompts[0].evidence_ref, undefined);
});
test("matchesBrandAlias returns the same branded result used by validatePanel", () => {
  const aliases = ["Offcult", "offcult.in"];
  const text = "Is Offcult a good streetwear choice?";
  const panel = validatePanel({
    persona: "Streetwear shoppers",
    context: { country: "in" },
    prompts: [{ text, origin: "manual" }],
  }, { brandAliases: aliases });
  assert.equal(matchesBrandAlias(text, aliases), true);
  assert.equal(panel.prompts[0].purpose === "diagnostic", matchesBrandAlias(text, aliases));
});
test("R05: recommendation eligibility and unreviewed qualification survive summary and headline aggregation", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    engine: "chatgpt",
    prompt: `Question ${i}`,
    answer_present: true,
    text: "No brand named here.",
    visible: false,
    brand_mentioned_in_text: false,
    brand_cited: false,
    brands: [],
    error: null,
  }));
  const options = {
    panelApproved: false,
    plannedQueries: rows.map((r) => r.prompt),
    plannedEligibility: rows.map((r, i) => ({
      text: r.prompt,
      purpose: i === 0 ? "recommendation" : "information",
    })),
  };
  const slice = summarizeEngineSlice(rows, "chatgpt", options);
  assert.equal(slice.metrics[METRIC_IDS.MENTION].denominator, 30);
  assert.equal(slice.metrics[METRIC_IDS.MENTION].value_pct, 0);
  assert.equal(slice.metrics[METRIC_IDS.RECOMMENDATION].denominator <= 1, true);
  assert.equal(
    slice.metrics[METRIC_IDS.MENTION].uncertainty.effective_sample,
    30,
  );
  assert.equal(computeHeadline([slice], undefined, options).headline_pct, null);
});
test("R16: verified passage needs actual current source text; citation or retrieval is not inferred", () => {
  const source = makeSourceSnapshot({
    url: "https://example.com/page?utm_source=ignored",
    text: "A specific source passage describes the observed product capability.",
  });
  assert.equal(
    verifySourcePassage(source, "A specific source passage").verified,
    true,
  );
  assert.equal(
    verifySourcePassage(source, "Fabricated unrelated text").verified,
    false,
  );
  assert.equal(
    verifySourcePassage(
      { ...source, captured_at: "2020-01-01" },
      "A specific source passage",
    ).reason,
    "source_stale",
  );
  const o = opportunityFromEvidence({
    snapshot: source,
    passage: "A specific source passage",
    targetUrl: "https://example.com/work",
    owner: "Editor",
    mechanism: "Clarify supporting source",
  });
  assert.equal(o.retrieval_status, "unknown");
  assert.equal(o.score.repeat_observations, 0);
  assert.equal(o.outreach_sent, false);
});
test("R17: text or dependency edits invalidate approval even when a model claims a pass", () => {
  const item = {
    title: "A draft",
    body_md: "A sourced draft",
    research_pack: { evidence: researchEvidence({}) },
  };
  item.rubric = {
    check: draftCheck(item, item.research_pack, { passed: true, issues: [] }),
  };
  assert.equal(checkMatches(item), true);
  assert.equal(checkMatches({ ...item, body_md: "Edited" }), false);
  assert.equal(
    checkMatches({ ...item, research_pack: { new_source: "changed" } }),
    false,
  );
  const verdict = bindResearchCheck(
    { draft: item, researchPack: item.research_pack },
    { passed: true, issues: [] },
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.issues[0].kind, "missing_evidence");
  assert.equal(isCurrentCheck(verdict, item, item.research_pack), true);
});
test("R18: title-only or navigation-only pages cannot establish an approved body match", () => {
  const body =
    "The approved substantive source grounded publication describes a specific implementation with multiple detailed facts and no missing content from the reviewed body.";
  assert.equal(
    verifyBodyMatch(
      body,
      "<title>The approved substantive source grounded publication</title>",
    ).matched,
    false,
  );
  assert.equal(
    verifyBodyMatch(body, `<main><p>${body}</p></main>`).matched,
    true,
  );
  assert.equal(verifyBodyMatch(body, `<!-- ${body} -->`).matched, false);
  assert.equal(verifyBodyMatch("Short", body).matched, false);
});
test("R13: private missing and forbidden states are opaque; backend errors and malformed 200s remain retryable", () => {
  assert.deepEqual(reportResponseState(403, {}), reportResponseState(404, {}));
  assert.equal(reportResponseState(401, {}).state, "authentication_required");
  assert.equal(reportResponseState(500, {}).retryable, true);
  assert.equal(
    reportResponseState(200, { scan: null }).state,
    "contract_error",
  );
  assert.equal(
    reportResponseState(200, {
      scan: {
        id: "real",
        raw_results: {
          summary_stats: { terminal_outcome: { outcome: "partial" } },
        },
      },
    }).state,
    "partial",
  );
});
test("R04/R06: upload failure preserves explicit durable evidence state and redaction precedes hashing", async () => {
  const input = {
    payload: {
      authorization: "Bearer sk-EXAMPLE-NOT-A-REAL-KEY",
      cookie: "private-example",
      answer: "Observed answer",
    },
    surface: "aio",
    provider: "brightdata",
  };
  const doc = evidenceDocument(input);
  assert.equal(doc.body.includes("private-example"), false);
  assert.equal(doc.body.includes("sk-EXAMPLE-NOT-A-REAL-KEY"), false);
  assert.equal(doc.hash.length, 64);
  const rows = [];
  const store = createMeasurementEvidenceStore({
    from: () => ({ upsert: async (row) => (rows.push(row), { error: null }) }),
    storage: {
      from: () => ({
        upload: async () => ({ error: { message: "Unavailable" } }),
      }),
    },
  });
  const result = await store.capture({
    observationId: "obs",
    token: "attempt",
    ...input,
  });
  assert.equal(result.state, "write_failed");
  assert.deepEqual(
    rows.map((r) => r.state),
    ["pending", "write_failed"],
  );
  assert.equal(rows[1].object_key, undefined);
});

test("R19: approval timestamps and incompatible historical cohorts never produce publication lift", async () => {
  const { comparePublicationObservations } = await import(
    "./publicationObservation.js"
  );
  assert.equal(
    comparePublicationObservations({
      publication: { approved_at: "2026-10-19" },
      rowsForScan: () => [],
    }).reason,
    "verified_publication_required",
  );
  const publication = {
    published_at: "2026-10-10T12:00:00Z",
    target_queries: ["q"],
  };
  const scans = [
    { scanned_at: "2026-10-09T12:00:00Z" },
    { scanned_at: "2026-10-11T12:00:00Z" },
  ];
  const result = comparePublicationObservations({
    publication,
    scans,
    rowsForScan: () => [],
    now: Date.parse("2026-10-20"),
  });
  assert.equal(result.applicable, false);
  assert.equal(result.cited_delta, null);
  assert.equal(result.causal_claim, false);
});
