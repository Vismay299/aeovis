/**
 * R05-14 / R05-16 — observation identity and correlated replicates.
 *
 * WHY THESE TWO CASES SIT TOGETHER. Both are about the difference between "how
 * many deliveries arrived" and "how many independent measurements this stands
 * on", and both get a denominator wrong in the same flattering direction when
 * that difference is ignored: a retried result inflates the count, and a
 * repeated question pretends to be a sample of a market.
 *
 * R05-14 — the logical observation key (v1 policy: workspace, prompt/version,
 * panel, surface, market, language/device/session policy, scheduled time,
 * replicate, purpose) decides what ONE observation is. Attempts are children of
 * that key. `attempt` is deliberately NOT part of it: a second delivery of the
 * same observation is the same observation.
 *
 * R05-16 — the uncertainty estimate resamples PROMPT CLUSTERS, so three
 * replicates of one question carry one question's weight rather than three
 * independent samples' worth. Method and seed are recorded, because an interval
 * nobody can reproduce is not evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeEngineSlice } from "../scoring/enginePipeline.js";
import {
  METRIC_IDS,
  UNCERTAINTY_METHODS,
  dedupeObservations,
  estimateUncertainty,
  logicalObservationKey,
} from "../scoring/metricContract.js";

const SELF = "Acme";
const RIVAL = "RivalAlpha";

function probeRow(i, { names = "nobody", prompt = null, replicate = 1 } = {}) {
  const mentionsSelf = names === "self";
  const mentionsRival = names === "rival";
  return {
    engine: "aio",
    prompt: prompt ?? `buyer question ${i}`,
    is_branded_query: false,
    answer_present: true,
    aio_present: true,
    text: mentionsSelf ? "Acme is a solid choice." : mentionsRival ? "RivalAlpha is a solid choice." : "Follow the documentation.",
    citations: [],
    references: [],
    brand_mentioned_in_text: mentionsSelf,
    brand_cited: false,
    visible: mentionsSelf,
    brands: [
      { name: SELF, is_self: true, mentioned: mentionsSelf, position: mentionsSelf ? 1 : null, sentiment: mentionsSelf ? 100 : null },
      { name: RIVAL, is_self: false, mentioned: mentionsRival, position: mentionsRival ? 1 : null, sentiment: mentionsRival ? 100 : null },
    ],
    error: null,
    cost: 0.001,
    ...(replicate > 1 ? { replicate } : {}),
  };
}

test("R05-14 — duplicate ingestion counts each logical observation once", () => {
  const key = logicalObservationKey({
    workspace: "acme.io",
    promptId: "best crm for small teams",
    surface: "aio",
    market: "in",
    scheduledTime: "2026-10-16",
    replicate: 1,
  });
  const secondReplicate = logicalObservationKey({
    workspace: "acme.io",
    promptId: "best crm for small teams",
    surface: "aio",
    market: "in",
    scheduledTime: "2026-10-16",
    replicate: 2,
  });
  assert.notEqual(key, secondReplicate, "a second SCHEDULED observation of a prompt is its own observation");
  assert.equal(
    key,
    logicalObservationKey({ workspace: "acme.io", promptId: "best crm for small teams", surface: "aio", market: "in", scheduledTime: "2026-10-16", replicate: 1 }),
    "the same inputs produce the same key"
  );

  const deduped = dedupeObservations([
    { key, attempt: 1 },
    { key, attempt: 2 },
    { key, attempt: 3 },
    { key: secondReplicate, attempt: 1 },
  ]);
  assert.equal(deduped.unique.length, 2, "three attempts on one observation plus one replicate is two observations");
  assert.equal(deduped.duplicates, 2, "and the two extra deliveries are counted as duplicates, not hidden");

  // Through the real slice: a whole panel re-delivered changes the row count and
  // NOT the metric.
  const rows = Array.from({ length: 30 }, (_, i) => probeRow(i, { names: i < 6 ? "self" : "rival" }));
  const reDelivered = rows.map((row, i) => ({ ...row, attempt: 2, delivery_id: `retry-${i}` }));
  const slice = summarizeEngineSlice([...rows, ...reDelivered], "aio");
  const metric = slice.metrics[METRIC_IDS.EXPOSURE];

  assert.equal(slice.non_branded_with_answer, 60, "sixty rows arrived — that is a fact about the batch");
  assert.equal(metric.numerator, 6, "six observations named the brand");
  assert.equal(metric.denominator, 30, "and thirty observations were counted, once each");
  assert.equal(metric.value_pct, 20);
  assert.equal(metric.duplicate_observations, 30, "the duplicates are reported rather than silently dropped");
  assert.equal(metric.distinct_eligible_prompts, 30);
});

test("R05-16 — correlated replicates do not masquerade as independent samples, and the method/seed are recorded", () => {
  // Twenty questions, each observed three times, with the three replicates of a
  // question agreeing — which is what a repeat of one prompt actually looks
  // like: correlated, not independent.
  const observations = [];
  for (let p = 0; p < 20; p++) {
    for (let replicate = 1; replicate <= 3; replicate++) {
      observations.push({ promptId: `prompt-${p}`, replicate, value: p < 12 });
    }
  }

  const estimate = estimateUncertainty(observations, { seed: 4242 });
  assert.equal(estimate.method, UNCERTAINTY_METHODS.PROMPT_CLUSTER_BOOTSTRAP);
  assert.equal(estimate.seed, 4242, "the seed is recorded, so the interval is reproducible");
  assert.equal(estimate.observations, 60);
  assert.equal(estimate.replicate_observations, 40);
  assert.equal(estimate.effective_sample, 20, "twenty questions — NOT sixty deliveries — is the resampling unit");
  assert.equal(estimate.cluster_rate_pct, 60, "twelve of twenty questions named the brand");
  assert.ok(estimate.ci_low_pct >= 0 && estimate.ci_high_pct <= 100, "an interval runs inside 0-100");
  assert.ok(estimate.ci_low_pct <= 60 && 60 <= estimate.ci_high_pct, "the point estimate sits inside its own interval");
  assert.ok(estimate.ci_high_pct - estimate.ci_low_pct > 0, "twenty clustered questions are not certainty");

  // Same seed, same interval. A different seed may move it by a little; it must
  // not change what the interval is FOR.
  assert.deepEqual(estimateUncertainty(observations, { seed: 4242 }), estimate);

  // Thirty replicates of ONE question is an effective sample of one — which is
  // exactly why it cannot headline.
  const oneQuestion = Array.from({ length: 30 }, (_, i) => ({
    promptId: "best tiles in india",
    replicate: i + 1,
    value: i < 6,
  }));
  const single = estimateUncertainty(oneQuestion, { seed: 7 });
  assert.equal(single.observations, 30);
  assert.equal(single.effective_sample, 1, "thirty deliveries of one question is one question");
  assert.equal(single.replicate_observations, 29);
  assert.equal(single.cluster_rate_pct, 20, "and the rate they imply is still reported");

  // The same panel through the producer: the metric's distinct count agrees with
  // the clustering, so the uncertainty cannot claim a sample size the gate would
  // refuse.
  const slice = summarizeEngineSlice(
    Array.from({ length: 30 }, (_, i) => probeRow(i, { prompt: "best tiles in india", replicate: i + 1, names: i < 6 ? "self" : "rival" })),
    "aio"
  );
  assert.equal(slice.metrics[METRIC_IDS.EXPOSURE].distinct_eligible_prompts, single.effective_sample);
  assert.equal(slice.metrics[METRIC_IDS.EXPOSURE].qualified, false);

  // An empty corpus has NO interval rather than a zero-width one at 0%.
  const empty = estimateUncertainty([], { seed: 1 });
  assert.equal(empty.observations, 0);
  assert.equal(empty.cluster_rate_pct, null);
  assert.equal(empty.ci_low_pct, null);
  assert.equal(empty.ci_high_pct, null);
});
