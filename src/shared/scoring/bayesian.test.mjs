import test from 'node:test';
import assert from 'node:assert/strict';
import { ibeta, ibetainv, computePosterior } from './bayesian.js';

test('ibeta - correctness for standard values', () => {
  // Symmetric beta CDF at median should be 0.5
  assert.equal(Math.round(ibeta(0.5, 2.0, 2.0) * 100) / 100, 0.5);
  
  // Boundary checks
  assert.equal(ibeta(0, 2.0, 2.0), 0);
  assert.equal(ibeta(1, 2.0, 2.0), 1);
});

test('ibetainv - correctness for standard values', () => {
  // Symmetric beta inverse CDF at 0.5 should be 0.5
  assert.equal(Math.round(ibetainv(0.5, 2.0, 2.0) * 100) / 100, 0.5);
  
  // Inverse maps back correctly
  const p = 0.25;
  const a = 3.0;
  const b = 5.0;
  const x = ibetainv(p, a, b);
  const pCalc = ibeta(x, a, b);
  assert.ok(Math.abs(pCalc - p) < 1e-6);
});

test('computePosterior - posterior calculations matching expectation', () => {
  const prior = 0.35; // SaaS prior
  const observedMentions = 15;
  const totalPrompts = 30;
  
  const { posteriorMean, credibleIntervalLow, credibleIntervalHigh } = computePosterior(
    prior,
    observedMentions,
    totalPrompts,
    0.90, // 90% confidence
    10    // prior strength
  );

  // Total pseudo + real observations = 10 + 30 = 40
  // Alpha = 0.35 * 10 + 15 = 18.5
  // Beta = 0.65 * 10 + 15 = 21.5
  // Mean = 18.5 / 40 = 0.4625
  assert.equal(posteriorMean, 0.4625);

  // Low & High bounds should wrap the mean
  assert.ok(credibleIntervalLow < posteriorMean);
  assert.ok(credibleIntervalHigh > posteriorMean);

  // Bounds should be within [0, 1]
  assert.ok(credibleIntervalLow >= 0);
  assert.ok(credibleIntervalHigh <= 1);

  // Test that higher observations drag the posterior mean up
  const posHigh = computePosterior(prior, 28, 30, 0.90, 10);
  assert.ok(posHigh.posteriorMean > posteriorMean);
});
