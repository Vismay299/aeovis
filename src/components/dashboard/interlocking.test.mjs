import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInterlocking } from './interlocking.js';

/**
 * R2.8.2 — a zero-row engine says 'no data'.
 *
 * Before the fix, `scoped = of.length ? of : rows` silently inherited ALL rows
 * when an engine had none, so a completely absent engine appeared to report the
 * same coverage as the full set — inventing probe counts and cleared counts
 * from data that belonged to other engines.
 */

const BRAND = 'TestCo';

/** Helper: a single-engine result with some non-branded rows. */
function baseResult(rows, engineScores = {}) {
  return {
    brand: BRAND,
    rawResults: rows,
    nonBrandedResults: rows,
    engineScores: Object.keys(engineScores).length
      ? engineScores
      : { aio: 0.5 },
    promptsAnalyzed: rows.length,
    competitors: [],
  };
}

function row(engine, { branded = false, mentioned = false, cited = false } = {}) {
  return {
    engine,
    is_branded_query: branded,
    isBrandedQuery: branded,
    brand_mentioned_in_text: mentioned,
    brandMentionedInText: mentioned,
    brand_cited: cited,
    brandCited: cited,
    aio_present: true,
    aioPresent: true,
  };
}

// ── R2.8.2: zero-row engine marks noData ────────────────────────────────

it('R2.8.2 — an engine with zero rows marks noData=true', () => {
  const result = baseResult(
    [row('aio'), row('aio'), row('aio')],
    { aio: 0.5, perplexity: 0.5 },
  );
  const { engines } = buildInterlocking(result);
  const pplx = engines.find((e) => e.key === 'perplexity');
  assert.ok(pplx, 'perplexity engine is present');
  assert.equal(pplx.noData, true, 'perplexity has no rows → noData');
  assert.equal(pplx.probes, 0, 'probes is 0, not inherited');
  assert.equal(pplx.cleared, 0, 'cleared is 0, not inherited');
});

it('R2.8.2 — an engine with rows marks noData=false', () => {
  const result = baseResult(
    [row('aio', { mentioned: true }), row('aio')],
    { aio: 0.5, perplexity: 0.5 },
  );
  const { engines } = buildInterlocking(result);
  const aio = engines.find((e) => e.key === 'aio');
  assert.equal(aio.noData, false, 'aio has rows → not noData');
  assert.equal(aio.probes, 2, 'probes counts its own rows');
  assert.equal(aio.cleared, 1, 'cleared counts mentions in its own rows');
});

it('R2.8.2 — single-engine result: no fallback to all rows', () => {
  // Only AIO rows exist, but engineScores declares two engines
  const result = baseResult(
    [row('aio'), row('aio', { mentioned: true })],
    { aio: 0.5, gemini: 0.5 },
  );
  const { engines } = buildInterlocking(result);
  const gemini = engines.find((e) => e.key === 'gemini');
  assert.equal(gemini.noData, true, 'gemini has no rows → noData');
  assert.equal(gemini.probes, 0, 'gemini probes is 0');
  assert.equal(gemini.cleared, 0, 'gemini cleared is 0');

  const aio = engines.find((e) => e.key === 'aio');
  assert.equal(aio.noData, false);
  assert.equal(aio.probes, 2);
  assert.equal(aio.cleared, 1);
});

it('R2.8.2 — no engineScores key → defaults to aio with rows', () => {
  const result = {
    brand: BRAND,
    rawResults: [row('aio', { mentioned: true })],
    nonBrandedResults: [row('aio', { mentioned: true })],
    engineScores: {},
    promptsAnalyzed: 1,
    competitors: [],
  };
  const { engines } = buildInterlocking(result);
  assert.equal(engines.length, 1);
  assert.equal(engines[0].key, 'aio');
  assert.equal(engines[0].noData, false);
  assert.equal(engines[0].probes, 1);
  assert.equal(engines[0].cleared, 1);
});

it('R2.8.2 — all engines have rows → none marked noData', () => {
  const result = baseResult(
    [row('aio'), row('perplexity'), row('gemini')],
    { aio: 0.5, perplexity: 0.5, gemini: 0.5 },
  );
  const { engines } = buildInterlocking(result);
  assert.equal(engines.every((e) => e.noData === false), true, 'all engines have data');
});

it('R2.8.2 — all engines have zero rows → all marked noData', () => {
  const result = baseResult(
    [],
    { aio: 0.5, perplexity: 0.5 },
  );
  const { engines } = buildInterlocking(result);
  assert.equal(engines.every((e) => e.noData === true), true, 'all engines lack data');
  assert.equal(engines.every((e) => e.probes === 0), true, 'all probes are 0');
});

it('R2.8.2 — legacy single-engine with no engineScores defaults to aio', () => {
  const result = {
    brand: BRAND,
    rawResults: [row('aio', { mentioned: true }), row('aio')],
    nonBrandedResults: [row('aio', { mentioned: true }), row('aio')],
    engineScores: undefined,
    promptsAnalyzed: 2,
    competitors: [],
  };
  const { engines } = buildInterlocking(result);
  assert.equal(engines.length, 1);
  assert.equal(engines[0].key, 'aio');
  assert.equal(engines[0].noData, false);
  assert.equal(engines[0].probes, 2);
  assert.equal(engines[0].cleared, 1);
});

// ── platform/destinations unaffected ────────────────────────────────────

it('R2.8.2 — platforms are unaffected by engine noData', () => {
  const result = baseResult(
    [row('aio', { mentioned: true }), row('aio')],
    { aio: 0.5, perplexity: 0.5 },
  );
  const { platforms, total, answered } = buildInterlocking(result);
  assert.equal(total, 2, 'total counts all rows');
  assert.equal(answered, 2, 'answered counts all rows');
  // Platforms should still show the brand
  const you = platforms.find((p) => p.isYou);
  assert.ok(you, 'brand destination exists');
  assert.equal(you.count, 1, 'brand mentioned in 1 row');
});
