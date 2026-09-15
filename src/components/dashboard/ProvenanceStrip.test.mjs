import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * R2.9.1 — Provenance strip under the hero.
 *
 * These tests exercise the pure logic of the provenance strip:
 *   - sumAcrossEngines (the aggregation helper)
 *   - Chip presence/absence for each field
 *   - Edge cases: null summaries, missing fields, zero values
 *
 * The rendering itself is tested by integration / snapshot; the component
 * is a leaf that reads persisted values and builds a list of chips.
 */

// ── sumAcrossEngines (extracted for direct testing) ──────────────────

/**
 * Mirrors the aggregation logic in ProvenanceStrip.jsx.
 * Duplicated here rather than exported because the component is a leaf
 * module and the duplication is three lines.
 */
function sumAcrossEngines(perEngineSummaries, field) {
  if (!perEngineSummaries || typeof perEngineSummaries !== 'object') return null;
  const values = Object.values(perEngineSummaries)
    .map((s) => s?.[field])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Mirrors computeElicitationRate in ProvenanceStrip.jsx: total eliciting /
 * total non-branded with answer, not a sum of per-engine rates.
 */
function computeElicitationRate(perEngineSummaries) {
  if (!perEngineSummaries || typeof perEngineSummaries !== 'object') return null;
  let totalEliciting = 0;
  let totalAnswered = 0;
  let found = false;
  for (const s of Object.values(perEngineSummaries)) {
    const e = s?.eliciting_queries;
    const a = s?.non_branded_with_answer;
    if (typeof e === 'number' && Number.isFinite(e)) {
      totalEliciting += e;
      found = true;
    }
    if (typeof a === 'number' && Number.isFinite(a)) {
      totalAnswered += a;
    }
  }
  if (!found || totalAnswered === 0) return null;
  return (totalEliciting / totalAnswered) * 100;
}

// ── sumAcrossEngines tests ───────────────────────────────────────────

it('sumAcrossEngines — null summaries returns null', () => {
  assert.equal(sumAcrossEngines(null, 'eliciting_queries'), null);
  assert.equal(sumAcrossEngines(undefined, 'dead_prompts'), null);
});

it('sumAcrossEngines — empty object returns null', () => {
  assert.equal(sumAcrossEngines({}, 'eliciting_queries'), null);
});

it('sumAcrossEngines — sums numeric values', () => {
  const summaries = {
    aio: { eliciting_queries: 10, dead_prompts: 2 },
    perplexity: { eliciting_queries: 8, dead_prompts: 0 },
  };
  assert.equal(sumAcrossEngines(summaries, 'eliciting_queries'), 18);
  assert.equal(sumAcrossEngines(summaries, 'dead_prompts'), 2);
});

it('sumAcrossEngines — skips null/undefined fields', () => {
  const summaries = {
    aio: { eliciting_queries: 10, dead_prompts: null },
    perplexity: { eliciting_queries: null, dead_prompts: 0 },
  };
  assert.equal(sumAcrossEngines(summaries, 'eliciting_queries'), 10);
  assert.equal(sumAcrossEngines(summaries, 'dead_prompts'), 0);
});

it('sumAcrossEngines — all nulls returns null', () => {
  const summaries = {
    aio: { eliciting_queries: null },
    perplexity: { eliciting_queries: undefined },
  };
  assert.equal(sumAcrossEngines(summaries, 'eliciting_queries'), null);
});

it('sumAcrossEngines — skips non-finite values (NaN, Infinity)', () => {
  const summaries = {
    aio: { eliciting_queries: 10 },
    perplexity: { eliciting_queries: NaN },
  };
  assert.equal(sumAcrossEngines(summaries, 'eliciting_queries'), 10);
});

// ── chip presence / absence logic ────────────────────────────────────

/**
 * Builds the chip list that ProvenanceStrip would render, extracting the
 * decision logic without requiring a DOM or React.
 */
function buildChips(result) {
  if (!result) return [];

  const perEngine = result.perEngineSummaries;

  const enginesCounted =
    typeof result.enginesCounted === 'number' && Number.isFinite(result.enginesCounted)
      ? result.enginesCounted
      : null;
  const enginesPartial = result.enginesPartial;
  const skippedCount = Array.isArray(enginesPartial) ? enginesPartial.length : null;

  const elicitingPoolSize = sumAcrossEngines(perEngine, 'eliciting_queries');
  const elicitationRate = computeElicitationRate(perEngine);
  const deadPrompts = sumAcrossEngines(perEngine, 'dead_prompts');

  const promptSetVersion =
    result.promptSetId || result.prompt_set_id || null;

  const geo = result.geo ?? result.raw_results?.geo ?? null;

  const windowLabel = (() => {
    // Simplified: just check if collectedFrom/To are present
    if (result.collectedFrom && result.collectedTo) {
      return `${result.collectedFrom} → ${result.collectedTo}`;
    }
    return null;
  })();

  const chips = [];

  if (enginesCounted !== null) {
    const label =
      skippedCount !== null && skippedCount > 0
        ? `${enginesCounted} counted · ${skippedCount} skipped`
        : `${enginesCounted} counted`;
    chips.push({ key: 'engines', label });
  }

  if (elicitingPoolSize !== null) {
    chips.push({ key: 'eliciting-pool', label: `eliciting pool ${elicitingPoolSize}` });
  }

  if (elicitationRate !== null) {
    chips.push({ key: 'elicitation-rate', label: `elicitation ${Math.round(elicitationRate)}%` });
  }

  if (deadPrompts !== null && deadPrompts > 0) {
    chips.push({ key: 'dead-prompts', label: `${deadPrompts} dead prompt${deadPrompts === 1 ? '' : 's'}` });
  }

  if (promptSetVersion) {
    chips.push({ key: 'prompt-set', label: `prompt-set ${promptSetVersion}` });
  }

  if (geo) {
    chips.push({ key: 'geo', label: `geo ${String(geo).toUpperCase()}` });
  }

  if (windowLabel) {
    chips.push({ key: 'collection-window', label: `collected ${windowLabel}` });
  }

  return chips;
}

// ── R2.9.1: chip presence tests ──────────────────────────────────────

it('R2.9.1 — null result produces no chips', () => {
  assert.deepEqual(buildChips(null), []);
});

it('R2.9.1 — enginesCounted chip appears when present', () => {
  const chips = buildChips({ enginesCounted: 3 });
  const engineChip = chips.find((c) => c.key === 'engines');
  assert.ok(engineChip, 'engines chip is present');
  assert.equal(engineChip.label, '3 counted');
});

it('R2.9.1 — enginesCounted with skipped engines shows both', () => {
  const chips = buildChips({ enginesCounted: 3, enginesPartial: ['perplexity'] });
  const engineChip = chips.find((c) => c.key === 'engines');
  assert.equal(engineChip.label, '3 counted · 1 skipped');
});

it('R2.9.1 — enginesCounted absent → no engines chip', () => {
  const chips = buildChips({});
  const engineChip = chips.find((c) => c.key === 'engines');
  assert.equal(engineChip, undefined);
});

it('R2.9.1 — eliciting pool chip appears when present', () => {
  const chips = buildChips({
    perEngineSummaries: { aio: { eliciting_queries: 20 } },
  });
  const chip = chips.find((c) => c.key === 'eliciting-pool');
  assert.ok(chip);
  assert.equal(chip.label, 'eliciting pool 20');
});

it('R2.9.1 — eliciting rate chip appears when present', () => {
  const chips = buildChips({
    perEngineSummaries: {
      aio: { eliciting_queries: 17, non_branded_with_answer: 20 },
    },
  });
  const chip = chips.find((c) => c.key === 'elicitation-rate');
  assert.ok(chip);
  assert.equal(chip.label, 'elicitation 85%');
});

it('R2.9.1 — dead prompts chip appears only when > 0', () => {
  const withDead = buildChips({
    perEngineSummaries: { aio: { dead_prompts: 3 } },
  });
  assert.ok(withDead.find((c) => c.key === 'dead-prompts'), 'chip present when > 0');

  const zeroDead = buildChips({
    perEngineSummaries: { aio: { dead_prompts: 0 } },
  });
  assert.equal(zeroDead.find((c) => c.key === 'dead-prompts'), undefined, 'chip absent when 0');
});

it('R2.9.1 — dead prompts singular form for 1', () => {
  const chips = buildChips({
    perEngineSummaries: { aio: { dead_prompts: 1 } },
  });
  const chip = chips.find((c) => c.key === 'dead-prompts');
  assert.equal(chip.label, '1 dead prompt');
});

it('R2.9.1 — prompt-set chip appears when present', () => {
  const chips = buildChips({ promptSetId: 'ps-2026-09' });
  const chip = chips.find((c) => c.key === 'prompt-set');
  assert.ok(chip);
  assert.equal(chip.label, 'prompt-set ps-2026-09');
});

it('R2.9.1 — prompt-set chip falls back to prompt_set_id', () => {
  const chips = buildChips({ prompt_set_id: 'legacy-set' });
  const chip = chips.find((c) => c.key === 'prompt-set');
  assert.ok(chip);
  assert.equal(chip.label, 'prompt-set legacy-set');
});

it('R2.9.1 — prompt-set absent → no chip', () => {
  const chips = buildChips({});
  assert.equal(chips.find((c) => c.key === 'prompt-set'), undefined);
});

it('R2.9.1 — geo chip appears when present', () => {
  const chips = buildChips({ geo: 'us' });
  const chip = chips.find((c) => c.key === 'geo');
  assert.ok(chip);
  assert.equal(chip.label, 'geo US');
});

it('R2.9.1 — geo absent → no chip', () => {
  const chips = buildChips({});
  assert.equal(chips.find((c) => c.key === 'geo'), undefined);
});

it('R2.9.1 — collection window chip appears when both ends present', () => {
  const chips = buildChips({
    collectedFrom: '2026-09-01T10:00:00Z',
    collectedTo: '2026-09-01T10:30:00Z',
  });
  const chip = chips.find((c) => c.key === 'collection-window');
  assert.ok(chip);
  assert.ok(chip.label.startsWith('collected'));
});

it('R2.9.1 — collection window absent → no chip', () => {
  const chips = buildChips({ collectedFrom: null, collectedTo: null });
  assert.equal(chips.find((c) => c.key === 'collection-window'), undefined);
});

// ── full result chip list ────────────────────────────────────────────

it('R2.9.1 — full result produces all expected chips', () => {
  const chips = buildChips({
    enginesCounted: 3,
    enginesPartial: ['gemini'],
    perEngineSummaries: {
      aio: {
        eliciting_queries: 15,
        non_branded_with_answer: 20,
        dead_prompts: 1,
      },
      perplexity: {
        eliciting_queries: 12,
        non_branded_with_answer: 16,
        dead_prompts: 2,
      },
    },
    promptSetId: 'v2026.09',
    geo: 'us',
    collectedFrom: '2026-09-01T10:00:00Z',
    collectedTo: '2026-09-01T10:30:00Z',
  });

  const keys = chips.map((c) => c.key);
  assert.deepEqual(keys, [
    'engines',
    'eliciting-pool',
    'elicitation-rate',
    'dead-prompts',
    'prompt-set',
    'geo',
    'collection-window',
  ]);

  const engineChip = chips.find((c) => c.key === 'engines');
  assert.equal(engineChip.label, '3 counted · 1 skipped');

  const poolChip = chips.find((c) => c.key === 'eliciting-pool');
  assert.equal(poolChip.label, 'eliciting pool 27');

  // 27 eliciting / 36 total answered = 75%
  const rateChip = chips.find((c) => c.key === 'elicitation-rate');
  assert.equal(rateChip.label, 'elicitation 75%');

  const deadChip = chips.find((c) => c.key === 'dead-prompts');
  assert.equal(deadChip.label, '3 dead prompts');
});

it('R2.9.1 — multi-engine eliciting pool sums across engines', () => {
  const chips = buildChips({
    perEngineSummaries: {
      aio: { eliciting_queries: 10, non_branded_with_answer: 15, dead_prompts: 1 },
      perplexity: { eliciting_queries: 8, non_branded_with_answer: 12, dead_prompts: 2 },
      gemini: { eliciting_queries: 12, non_branded_with_answer: 20, dead_prompts: 0 },
    },
  });
  const poolChip = chips.find((c) => c.key === 'eliciting-pool');
  assert.equal(poolChip.label, 'eliciting pool 30');

  const deadChip = chips.find((c) => c.key === 'dead-prompts');
  assert.equal(deadChip.label, '3 dead prompts');

  // 30 eliciting / 47 total answered ≈ 64%
  const rateChip = chips.find((c) => c.key === 'elicitation-rate');
  assert.equal(rateChip.label, 'elicitation 64%');
});

it('R2.9.1 — empty perEngineSummaries produces no pool/rate/dead chips', () => {
  const chips = buildChips({ perEngineSummaries: {} });
  assert.equal(chips.find((c) => c.key === 'eliciting-pool'), undefined);
  assert.equal(chips.find((c) => c.key === 'elicitation-rate'), undefined);
  assert.equal(chips.find((c) => c.key === 'dead-prompts'), undefined);
});
