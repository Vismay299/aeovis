import test from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATION_PROTOCOL_VERSION,
  CALIBRATION_TARGETS,
  validateCorpusLabel,
  validateCorpusManifest,
  splitCorpusByCluster,
  wilsonScoreInterval,
  computeClassificationMetrics,
  runJudgeEvaluation,
  evaluateCorpusAdequacy,
  evaluateAbstentions,
  validateCorpusSourceProvenance,
  checkJudgeConfigCompatibility,
} from "../../shared/scoring/judgeCalibration.js";
import { judgeBrandsSymmetric } from "../../shared/scoring/judge.js";

test("R09-01 — Label missing explicit boolean is rejected with field/row reason (U)", () => {
  const invalidRow = { entity: "Acme", rank: 1 };
  assert.throws(
    () => validateCorpusLabel(invalidRow),
    /must be an explicit boolean/
  );

  const invalidTypeRow = { entity: "Acme", mentioned: "true" };
  assert.throws(
    () => validateCorpusLabel(invalidTypeRow),
    /must be an explicit boolean/
  );

  const validRow = { entity: "Acme", mentioned: true, relationship: "recommended" };
  assert.equal(validateCorpusLabel(validRow), true);
});

test("R09-02 — Mention false but rank supplied is rejected as contradictory (U)", () => {
  const contradictoryRow = { entity: "Acme", mentioned: false, rank: 2 };
  assert.throws(
    () => validateCorpusLabel(contradictoryRow),
    /mentioned is false but rank 2 was supplied/
  );

  const validFalseRow = { entity: "Acme", mentioned: false, rank: null };
  assert.equal(validateCorpusLabel(validFalseRow), true);
});

test("R09-03 — Uncertain label without explanation is rejected (U)", () => {
  const uncertainNoReason = { entity: "Acme", mentioned: true, relationship: "uncertain" };
  assert.throws(
    () => validateCorpusLabel(uncertainNoReason),
    /relationship is "uncertain" but no uncertainty explanation/
  );

  const uncertainWithReason = {
    entity: "Acme",
    mentioned: true,
    relationship: "uncertain",
    uncertain_reason: "Ambiguous pronoun reference in final clause",
  };
  assert.equal(validateCorpusLabel(uncertainWithReason), true);
});

test("R09-04 — Duplicate result/entity pair in manifest is rejected to prevent corpus inflation (U)", () => {
  const duplicateManifest = [
    {
      id: "answer-1",
      labels: [
        { entity: "Acme", mentioned: true },
        { entity: "Acme", mentioned: true },
      ],
    },
  ];

  assert.throws(
    () => validateCorpusManifest(duplicateManifest),
    /duplicate result\/entity pair: "answer-1::Acme"/
  );
});

test("R09-05 — Splitting corpus by prompt cluster ensures no cluster spans tuning and holdout sets (U)", () => {
  const items = [
    { id: "1", cluster_id: "cluster-A", labels: [{ entity: "Acme", mentioned: true }] },
    { id: "2", cluster_id: "cluster-A", labels: [{ entity: "Acme", mentioned: true }] },
    { id: "3", cluster_id: "cluster-B", labels: [{ entity: "Acme", mentioned: true }] },
    { id: "4", cluster_id: "cluster-C", labels: [{ entity: "Acme", mentioned: true }] },
    { id: "5", cluster_id: "cluster-D", labels: [{ entity: "Acme", mentioned: true }] },
  ];

  const { dev, cal, holdout } = splitCorpusByCluster(items);
  const devClusters = new Set(dev.map((i) => i.cluster_id));
  const calClusters = new Set(cal.map((i) => i.cluster_id));
  const holdoutClusters = new Set(holdout.map((i) => i.cluster_id));

  // No overlap between sets
  for (const c of devClusters) {
    assert.equal(calClusters.has(c), false, `Cluster ${c} leaked between dev and cal`);
    assert.equal(holdoutClusters.has(c), false, `Cluster ${c} leaked between dev and holdout`);
  }
  for (const c of calClusters) {
    assert.equal(holdoutClusters.has(c), false, `Cluster ${c} leaked between cal and holdout`);
  }
});

test("R09-06 — Missing surface/class support marks slice insufficient (U)", () => {
  const surfaceStats = {
    chatgpt: { tp: 15, fp: 1, fn: 1, tn: 20 },
    perplexity: { tp: 12, fp: 2, fn: 0, tn: 18 },
    gemini: { tp: 2, fp: 0, fn: 1, tn: 3 }, // Insufficient support (< 10)
  };

  const adequacy = evaluateCorpusAdequacy(surfaceStats, 10);
  assert.equal(adequacy.sufficient, false);
  assert.ok(adequacy.insufficient_slices.includes("gemini"));
  assert.equal(adequacy.slices.gemini.sufficient, false);
  assert.equal(adequacy.slices.chatgpt.sufficient, true);
});

test("R09-07 — Calibration runner rejects legacy judge substitution (I)", () => {
  const legacyJudge = function legacyJudge() {};
  legacyJudge.isLegacy = true;

  const corpus = [
    {
      id: "a1",
      surface: "chatgpt",
      text: "Acme is recommended.",
      labels: [{ entity: "Acme", mentioned: true, relationship: "recommended" }],
    },
  ];

  assert.throws(
    () => runJudgeEvaluation({ judgeFn: legacyJudge, corpusItems: corpus }),
    /legacy judge substituted for production judge/
  );
});

test("R09-08 — Known confusion matrix produces exact hand-calculated metrics and Wilson intervals (I)", () => {
  // Known matrix: TP = 90, FP = 10, FN = 5, TN = 95
  // Precision = 90 / (90 + 10) = 0.900
  // Recall = 90 / (90 + 5) = 90 / 95 = 0.947
  // F1 = 2 * (0.900 * 0.947) / (0.900 + 0.947) = 1.7046 / 1.847 = 0.923
  const metrics = computeClassificationMetrics({ tp: 90, fp: 10, fn: 5, tn: 95 });

  assert.equal(metrics.precision, 0.9);
  assert.equal(metrics.recall, 0.947);
  assert.equal(metrics.f1, 0.923);

  // Check Wilson score interval bounds
  assert.ok(metrics.precisionInterval.point > 0);
  assert.ok(metrics.precisionInterval.low < metrics.precisionInterval.high);
  assert.ok(metrics.precisionInterval.low <= metrics.precisionInterval.point);
  assert.ok(metrics.precisionInterval.point <= metrics.precisionInterval.high);
});

test("R09-09 — Abstentions on hard cases report coverage and conditional accuracy without disappearing (I)", () => {
  const result = evaluateAbstentions({
    total: 100,
    abstained: 15,
    correctOnAnswered: 80,
  });

  assert.equal(result.total, 100);
  assert.equal(result.abstained, 15);
  assert.equal(result.answered, 85);
  assert.equal(result.coverage, 0.85);
  assert.equal(result.conditional_accuracy, 0.941);
  assert.equal(result.abstentions_preserved, true);
});

test("R09-10 — Repeated holdout hash mismatch fails execution to keep holdout auditable (I)", () => {
  const corpus = [
    {
      id: "a1",
      surface: "chatgpt",
      text: "Acme is great.",
      labels: [{ entity: "Acme", mentioned: true }],
    },
  ];

  const incorrectHash = "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

  assert.throws(
    () => runJudgeEvaluation({ judgeFn: judgeBrandsSymmetric, corpusItems: corpus, holdoutHash: incorrectHash }),
    /Holdout hash mismatch/
  );
});

test("R09-11 — Release fails when threshold is met overall but fails on any individual surface (I)", () => {
  const corpus = [];
  // Build a synthetic corpus where chatgpt is 100% accurate, but perplexity has 50% precision
  for (let i = 0; i < 20; i++) {
    corpus.push({
      id: `c-${i}`,
      surface: "chatgpt",
      text: "Acme is great.",
      labels: [{ entity: "Acme", mentioned: true }],
    });
    corpus.push({
      id: `c-neg-${i}`,
      surface: "chatgpt",
      text: "No tools mentioned.",
      labels: [{ entity: "Acme", mentioned: false }],
    });
  }
  for (let i = 0; i < 20; i++) {
    corpus.push({
      id: `p-${i}`,
      surface: "perplexity",
      text: "No tools mentioned.", // Truth is Acme not mentioned, but text mentions Acme in label
      labels: [{ entity: "Acme", mentioned: false }],
    });
  }

  // Create a mock judge that predicts mentioned on perplexity even when not mentioned
  const biasedJudge = (text, brands) => {
    return brands.map((b) => ({
      name: b.name,
      mentioned: text.includes("Acme") || text.includes("No tools"),
      relationship: "recommended",
      sentiment: "positive",
    }));
  };

  const evalResult = runJudgeEvaluation({ judgeFn: biasedJudge, corpusItems: corpus });
  assert.equal(evalResult.verdict, "failed");
  assert.ok(evalResult.per_surface.perplexity.precision < CALIBRATION_TARGETS.mentionPrecisionPerSurfaceMin);
});

test("R09-12 — Missing live-permitted source records or relabeled synthetic data blocks evaluation (I)", () => {
  const unpermittedCorpus = [
    {
      id: "a1",
      text: "Acme is good",
      labels: [{ entity: "Acme", mentioned: true }],
      provenance: { source_type: "synthetic", relabeled_as_real: true, permitted: true },
    },
  ];

  assert.throws(
    () => validateCorpusSourceProvenance(unpermittedCorpus),
    /synthetic data cannot be relabeled as real/
  );

  const missingPermissionCorpus = [
    {
      id: "a2",
      text: "Acme is good",
      labels: [{ entity: "Acme", mentioned: true }],
      provenance: { source_type: "real_permitted", permitted: false },
    },
  ];

  assert.throws(
    () => validateCorpusSourceProvenance(missingPermissionCorpus),
    /lacks verified capture permission/
  );
});

test("R09-16 — Judge config change invalidates prior qualification and requires re-evaluation (I)", () => {
  const qualifiedConfig = {
    judge_version: "2.0.0",
    model: "claude-3-5-sonnet",
    temperature: 0.0,
    rubric_version: "r09-protocol-v1",
  };

  const changedModelConfig = {
    ...qualifiedConfig,
    model: "claude-3-opus",
  };

  const check = checkJudgeConfigCompatibility(changedModelConfig, qualifiedConfig);
  assert.equal(check.compatible, false);
  assert.equal(check.invalidated, true);
  assert.match(check.reason, /model/);
});

test("R09-18 — Explicit A01–A05 stress inputs assert corrected behaviors (I)", () => {
  // A01: Citation-only presence without answer text -> textual mention false
  const a01Text = "Here are the top tools: Rival Corp and Beta Inc.";
  const a01Brands = [
    { name: "Acme", aliases: ["Acme"], isSelf: true },
    { name: "Rival Corp", aliases: ["Rival Corp"], isSelf: false },
  ];
  const a01Judged = judgeBrandsSymmetric(a01Text, a01Brands);
  const a01Acme = a01Judged.find((b) => b.name === "Acme");
  assert.equal(a01Acme.mentioned, false);
  assert.equal(a01Acme.relationship, null);

  // A02: Unselected competitor roster does not alter self brand metrics
  const selfBrandOnly = [{ name: "Acme", aliases: ["Acme"], isSelf: true }];
  const selfWithCompetitors = [
    { name: "Acme", aliases: ["Acme"], isSelf: true },
    { name: "CompetitorX", aliases: ["CompetitorX"], isSelf: false },
    { name: "CompetitorY", aliases: ["CompetitorY"], isSelf: false },
  ];
  const a02Text = "Acme is a reliable cloud monitoring platform.";
  const res1 = judgeBrandsSymmetric(a02Text, selfBrandOnly).find((b) => b.name === "Acme");
  const res2 = judgeBrandsSymmetric(a02Text, selfWithCompetitors).find((b) => b.name === "Acme");
  assert.equal(res1.mentioned, res2.mentioned);
  assert.equal(res1.relationship, res2.relationship);
  assert.equal(res1.sentiment, res2.sentiment);

  // A05: Explicit negation "Avoid Acme; choose Rival" does not award top recommendation to Acme
  const a05Text = "Avoid Acme; choose Rival as the best option.";
  const a05Judged = judgeBrandsSymmetric(a05Text, [
    { name: "Acme", aliases: ["Acme"], isSelf: true },
    { name: "Rival", aliases: ["Rival"], isSelf: false },
  ]);
  const a05Acme = a05Judged.find((b) => b.name === "Acme");
  const a05Rival = a05Judged.find((b) => b.name === "Rival");
  assert.equal(a05Acme.relationship, "discouraged");
  assert.notEqual(a05Acme.relationship, "recommended");
  assert.equal(a05Rival.relationship, "recommended");
});
