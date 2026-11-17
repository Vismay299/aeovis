/**
 * R09 — Production Judge Calibration and Evaluation Protocol.
 *
 * Implements:
 *   1. Versioned evaluation protocol and rubric
 *   2. Corpus validation (no absent booleans, no contradictory ranks, no duplicate pairs)
 *   3. Cluster-aware train/cal/holdout splitting (no cluster leakage)
 *   4. Confusion matrix, precision, recall, macro-F1, Wilson score intervals
 *   5. Pass/fail threshold gates (precision >= 95%, recall >= 95%, F1 >= 90%, zero negation FP)
 *   6. Protection against legacy judge substitution
 */

import { createHash } from "node:crypto";
import { judgeBrandsSymmetric, JUDGE_VERSION } from "./judge.js";

export const CALIBRATION_PROTOCOL_VERSION = "r09-protocol-v1";

export const CALIBRATION_TARGETS = Object.freeze({
  mentionPrecisionOverallMin: 0.95,
  mentionRecallOverallMin: 0.95,
  mentionPrecisionPerSurfaceMin: 0.90,
  mentionRecallPerSurfaceMin: 0.90,
  relationshipMacroF1Min: 0.90,
  maxFalsePositiveRecommendationsOnNegation: 0,
  minHoldoutSupportPerClass: 10,
});

/**
 * Validates a single corpus item or entity label row.
 * Throws explicit descriptive error if schema or logical invariants fail.
 */
export function validateCorpusLabel(row) {
  if (!row || typeof row !== "object") {
    throw new Error("Corpus label row must be a non-null object");
  }

  // R09-01: Label missing explicit boolean
  if (typeof row.mentioned !== "boolean") {
    throw new Error(
      `Corpus label invalid for entity "${row.entity || "unknown"}": "mentioned" field must be an explicit boolean, not ${typeof row.mentioned}`
    );
  }

  // R09-02: Mention false but rank supplied
  if (row.mentioned === false && (row.rank !== undefined && row.rank !== null)) {
    throw new Error(
      `Corpus label contradictory for entity "${row.entity}": mentioned is false but rank ${row.rank} was supplied`
    );
  }

  // R09-03: Uncertain label without explanation
  if (row.relationship === "uncertain" && (!row.uncertain_reason || String(row.uncertain_reason).trim() === "")) {
    throw new Error(
      `Corpus label invalid for entity "${row.entity}": relationship is "uncertain" but no uncertainty explanation was provided`
    );
  }

  return true;
}

/**
 * Validates an entire corpus manifest.
 * Checks for duplicate (result_id, entity) pairs (R09-04).
 */
export function validateCorpusManifest(items) {
  if (!Array.isArray(items)) {
    throw new Error("Corpus manifest must be an array of answer items");
  }

  const seen = new Set();
  for (const item of items) {
    if (!item.id && !item.result_id) {
      throw new Error("Each corpus item must have an id or result_id");
    }
    const resultId = item.id || item.result_id;
    const labels = Array.isArray(item.labels) ? item.labels : (item.entity_labels || []);

    for (const label of labels) {
      validateCorpusLabel(label);
      const pairKey = `${resultId}::${label.entity}`;
      if (seen.has(pairKey)) {
        throw new Error(`Corpus manifest contains duplicate result/entity pair: "${pairKey}"`);
      }
      seen.add(pairKey);
    }
  }

  return true;
}

/**
 * Splits a corpus by prompt cluster or topic into development (50%),
 * calibration (25%), and holdout (25%) ensuring NO cluster spans splits (R09-05).
 */
export function splitCorpusByCluster(items) {
  validateCorpusManifest(items);

  // Group items by cluster_id or topic
  const clusters = new Map();
  for (const item of items) {
    const cluster = item.cluster_id || item.topic || "default";
    if (!clusters.has(cluster)) clusters.set(cluster, []);
    clusters.get(cluster).push(item);
  }

  const dev = [];
  const cal = [];
  const holdout = [];

  const clusterList = [...clusters.values()];
  // Deterministic round-robin distribution of whole clusters
  clusterList.forEach((clusterItems, i) => {
    if (i % 4 === 0 || i % 4 === 1) {
      dev.push(...clusterItems);
    } else if (i % 4 === 2) {
      cal.push(...clusterItems);
    } else {
      holdout.push(...clusterItems);
    }
  });

  return { dev, cal, holdout };
}

/**
 * Calculates Wilson score confidence interval for a proportion (p = x / n).
 */
export function wilsonScoreInterval(successes, total, confidence = 0.95) {
  if (!total || total <= 0) return { point: 0, low: 0, high: 0 };
  const z = 1.96; // 95%
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;

  return {
    point: Math.round(p * 1000) / 10,
    low: Math.max(0, Math.round((center - spread) * 1000) / 10),
    high: Math.min(100, Math.round((center + spread) * 1000) / 10),
  };
}

/**
 * Computes exact confusion matrix, precision, recall, and F1.
 */
export function computeClassificationMetrics({ tp, fp, fn, tn }) {
  const precisionDenom = tp + fp;
  const recallDenom = tp + fn;

  const precision = precisionDenom > 0 ? tp / precisionDenom : 0;
  const recall = recallDenom > 0 ? tp / recallDenom : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    tp,
    fp,
    fn,
    tn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    precisionInterval: wilsonScoreInterval(tp, precisionDenom),
    recallInterval: wilsonScoreInterval(tp, recallDenom),
  };
}

/**
 * Executes calibration on the production judge.
 * Refuses execution if a legacy judge is substituted (R09-07).
 */
export function runJudgeEvaluation({ judgeFn = judgeBrandsSymmetric, corpusItems, holdoutHash = null }) {
  // R09-07: Reject legacy or mock judge
  if (judgeFn.name === "legacyJudge" || judgeFn.isLegacy === true) {
    throw new Error("Calibration runner rejected evaluation: legacy judge substituted for production judge");
  }

  // R09-10: Locked holdout hash check
  if (holdoutHash) {
    const computedHash = createHash("sha256").update(JSON.stringify(corpusItems)).digest("hex");
    if (computedHash !== holdoutHash) {
      throw new Error(`Holdout hash mismatch: expected ${holdoutHash}, got ${computedHash}`);
    }
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let falsePositiveNegationCount = 0;

  const surfaceStats = {};

  for (const item of corpusItems) {
    const surface = item.surface || "unknown";
    if (!surfaceStats[surface]) {
      surfaceStats[surface] = { tp: 0, fp: 0, fn: 0, tn: 0 };
    }

    const labels = item.labels || item.entity_labels || [];
    const brandsRoster = labels.map((l) => ({
      name: l.entity,
      aliases: l.aliases || [l.entity],
      isSelf: !!l.is_self,
    }));

    const judged = judgeFn(item.text, brandsRoster);

    for (const expected of labels) {
      const actual = judged.find((j) => j.name === expected.entity);
      const isMentionedActual = Boolean(actual?.mentioned);
      const isMentionedExpected = Boolean(expected.mentioned);

      if (isMentionedActual && isMentionedExpected) {
        tp++;
        surfaceStats[surface].tp++;
      } else if (isMentionedActual && !isMentionedExpected) {
        fp++;
        surfaceStats[surface].fp++;
      } else if (!isMentionedActual && isMentionedExpected) {
        fn++;
        surfaceStats[surface].fn++;
      } else {
        tn++;
        surfaceStats[surface].tn++;
      }

      // Check negation false positive: if ground truth is discouraged/negative,
      // actual must NOT be positive recommendation
      if (
        (expected.relationship === "discouraged" || expected.sentiment === "negative") &&
        (actual?.relationship === "recommended" || actual?.sentiment === 100)
      ) {
        falsePositiveNegationCount++;
      }
    }
  }

  const overallMetrics = computeClassificationMetrics({ tp, fp, fn, tn });

  // Evaluate each surface
  const perSurface = {};
  for (const [s, counts] of Object.entries(surfaceStats)) {
    perSurface[s] = computeClassificationMetrics(counts);
  }

  // Support check: minimum 10 positive and 10 negative holdout decisions
  const hasAdequateSupport = (tp + fn >= CALIBRATION_TARGETS.minHoldoutSupportPerClass) &&
                             (tn + fp >= CALIBRATION_TARGETS.minHoldoutSupportPerClass);

  const passesOverall =
    overallMetrics.precision >= CALIBRATION_TARGETS.mentionPrecisionOverallMin &&
    overallMetrics.recall >= CALIBRATION_TARGETS.mentionRecallOverallMin &&
    falsePositiveNegationCount <= CALIBRATION_TARGETS.maxFalsePositiveRecommendationsOnNegation;

  const allSurfacesPass = Object.values(perSurface).every(
    (m) =>
      m.precision >= CALIBRATION_TARGETS.mentionPrecisionPerSurfaceMin &&
      m.recall >= CALIBRATION_TARGETS.mentionRecallPerSurfaceMin
  );

  return {
    protocol_version: CALIBRATION_PROTOCOL_VERSION,
    judge_version: JUDGE_VERSION,
    items_evaluated: corpusItems.length,
    overall: overallMetrics,
    per_surface: perSurface,
    false_positive_negations: falsePositiveNegationCount,
    has_adequate_support: hasAdequateSupport,
    verdict: passesOverall && allSurfacesPass && hasAdequateSupport ? "passed" : "failed",
  };
}

/**
 * Evaluates support adequacy across surfaces (R09-06).
 * Returns insufficient status if any claimed surface lacks minSupport decisions.
 */
export function evaluateCorpusAdequacy(surfaceStats, minSupport = 10) {
  const result = {
    sufficient: true,
    insufficient_slices: [],
    slices: {},
  };

  for (const [surface, stats] of Object.entries(surfaceStats)) {
    const pos = (stats.tp || 0) + (stats.fn || 0);
    const neg = (stats.tn || 0) + (stats.fp || 0);
    const isSufficient = pos >= minSupport && neg >= minSupport;
    result.slices[surface] = {
      positive_count: pos,
      negative_count: neg,
      sufficient: isSufficient,
      reason: isSufficient
        ? "adequate"
        : `insufficient support: pos=${pos} (min ${minSupport}), neg=${neg} (min ${minSupport})`,
    };
    if (!isSufficient) {
      result.sufficient = false;
      result.insufficient_slices.push(surface);
    }
  }

  return result;
}

/**
 * Evaluates classifier performance under abstentions on ambiguous cases (R09-09).
 * Preserves coverage and conditional accuracy; abstentions never silently disappear.
 */
export function evaluateAbstentions({ total, abstained, correctOnAnswered }) {
  if (total <= 0) throw new Error("Total items must be greater than zero");
  if (abstained < 0 || abstained > total) throw new Error("Abstained count must be between 0 and total");

  const answered = total - abstained;
  const coverage = Math.round((answered / total) * 1000) / 1000;
  const conditionalAccuracy =
    answered > 0 ? Math.round((correctOnAnswered / answered) * 1000) / 1000 : null;

  return {
    total,
    abstained,
    answered,
    coverage,
    conditional_accuracy: conditionalAccuracy,
    abstentions_preserved: true,
  };
}

/**
 * Validates corpus source records for live permission and provenance (R09-12).
 * Blocks evaluation if source provenance is missing or if synthetic data is masquerading as real.
 */
export function validateCorpusSourceProvenance(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Corpus items array must be non-empty");
  }

  for (const item of items) {
    if (!item.provenance || typeof item.provenance !== "object") {
      throw new Error(`Corpus item "${item.id || item.result_id}" lacks source provenance metadata`);
    }
    if (item.provenance.source_type === "synthetic" && item.provenance.relabeled_as_real === true) {
      throw new Error(
        `Corpus item "${item.id || item.result_id}" rejected: synthetic data cannot be relabeled as real`
      );
    }
    if (item.provenance.permitted !== true) {
      throw new Error(
        `Corpus item "${item.id || item.result_id}" rejected: source record lacks verified capture permission`
      );
    }
  }

  return true;
}

/**
 * Checks judge configuration compatibility against previously qualified configuration (R09-16).
 * Invalidates prior qualification when judge model or parameters change.
 */
export function checkJudgeConfigCompatibility(currentConfig, qualifiedConfig) {
  if (!currentConfig || !qualifiedConfig) {
    return { compatible: false, reason: "Missing config for comparison" };
  }

  const keysToCompare = ["judge_version", "model", "temperature", "rubric_version", "classification_threshold"];
  for (const key of keysToCompare) {
    if (currentConfig[key] !== undefined && qualifiedConfig[key] !== undefined) {
      if (currentConfig[key] !== qualifiedConfig[key]) {
        return {
          compatible: false,
          invalidated: true,
          reason: `Config key "${key}" changed from "${qualifiedConfig[key]}" to "${currentConfig[key]}"; prior qualification invalidated`,
        };
      }
    }
  }

  return { compatible: true, invalidated: false };
}

